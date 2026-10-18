/** Probe originals and create short, temporary, model-supported media segments. */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

const COMMAND_TIMEOUT_MS = 120_000;

function run(command: string, args: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${command} превысил лимит времени ${timeoutMs} мс`));
    }, timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8_000) stderr += Buffer.from(chunk).toString("utf8").slice(0, 8_000 - stderr.length);
    });
    child.on("error", (error) =>
      finish(new Error(`${command} не запустился (${error.message}) — проверьте установку и путь к программе`)),
    );
    child.on("close", (code) =>
      code === 0 ? finish() : finish(new Error(`${command}: ${stderr.trim() || `код ${code}`}`)),
    );
  });
}

function capture(command: string, args: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${command} превысил лимит времени ${timeoutMs} мс`));
    }, timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    child.stdout.on("data", (chunk) => {
      stdout += Buffer.from(chunk).toString("utf8");
      if (stdout.length > 1_000_000) {
        child.kill("SIGKILL");
        finish(new Error(`${command} вернул слишком большой вывод`));
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8_000) stderr += Buffer.from(chunk).toString("utf8").slice(0, 8_000 - stderr.length);
    });
    child.on("error", (error) => finish(new Error(`${command} не запустился (${error.message})`)));
    child.on("close", (code) =>
      code === 0 ? finish() : finish(new Error(`${command}: ${stderr.trim() || `код ${code}`}`)),
    );
  });
}

async function withTemp<T>(input: Buffer, work: (dir: string, file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "telegram-rag-"));
  try {
    const file = join(dir, "input");
    await writeFile(file, input);
    return await work(dir, file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface MediaProbe {
  duration: number;
  formatName: string;
  hasAudio: boolean;
  hasVideo: boolean;
  width?: number;
  height?: number;
  audioCodec?: string;
  videoCodec?: string;
}

/** Inspect the bytes, not only the extension or Telegram's claimed MIME. */
export async function probeMedia(input: Buffer): Promise<MediaProbe> {
  return withTemp(input, async (_dir, file) => {
    const raw = await capture(FFPROBE, [
      "-v", "error",
      "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height,duration",
      "-of", "json",
      file,
    ]);
    let result: {
      format?: { format_name?: string; duration?: string };
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }>;
    };
    try {
      result = JSON.parse(raw);
    } catch {
      throw new Error("ffprobe вернул некорректный JSON");
    }
    const streams = result.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const durations = [result.format?.duration, ...streams.map((stream) => stream.duration)]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    const duration = durations.length > 0 ? Math.max(...durations) : 0;
    if (!video && !audio) throw new Error("медиафайл не содержит аудио- или видеопотока");
    return {
      duration,
      formatName: result.format?.format_name ?? "",
      hasAudio: Boolean(audio),
      hasVideo: Boolean(video),
      width: video?.width,
      height: video?.height,
      audioCodec: audio?.codec_name,
      videoCodec: video?.codec_name,
    };
  });
}

/** Preserve supported PNG/JPEG originals unless size or dimensions require a temporary derivative. */
export async function prepareImage(
  input: Buffer,
  mimeType: string,
  probe: MediaProbe,
  maxSide = 1536,
): Promise<{ bytes: Buffer; mimeType: "image/jpeg" | "image/png" }> {
  const supported = mimeType === "image/jpeg" || mimeType === "image/png";
  const smallEnough = input.byteLength <= 4 * 1_048_576;
  const dimensionsOk = Math.max(probe.width ?? 0, probe.height ?? 0) <= maxSide;
  if (supported && smallEnough && dimensionsOk) {
    return { bytes: input, mimeType: mimeType as "image/jpeg" | "image/png" };
  }
  return { bytes: await resizeImage(input, maxSide), mimeType: "image/jpeg" };
}

export interface MediaSegmentBytes {
  video: Buffer | null;
  audio: Buffer | null;
}

/** Build one temporary, bounded-duration segment; video and audio use the same seek window. */
export async function extractMediaSegment(
  input: Buffer,
  startSeconds: number,
  durationSeconds: number,
  streams: { video: boolean; audio: boolean },
): Promise<MediaSegmentBytes> {
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new TypeError("Некорректные границы сегмента медиа");
  }
  return withTemp(input, async (dir, file) => {
    let video: Buffer | null = null;
    let audio: Buffer | null = null;
    const seek = startSeconds.toFixed(3);
    const duration = durationSeconds.toFixed(3);

    if (streams.video) {
      const out = join(dir, "segment.mp4");
      await run(FFMPEG, [
        "-ss", seek, "-accurate_seek", "-i", file, "-t", duration,
        "-map", "0:v:0", "-an",
        "-vf", "scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=640:360:(ow-iw)/2:(oh-ih)/2",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "29", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-f", "mp4", out,
      ]);
      video = await readFile(out);
      if (video.length === 0) throw new Error("ffmpeg создал пустой видеосегмент");
    }

    if (streams.audio) {
      const out = join(dir, "segment.wav");
      await run(FFMPEG, [
        "-ss", seek, "-accurate_seek", "-i", file, "-t", duration,
        "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", out,
      ]);
      audio = await readFile(out);
      if (audio.length === 0) throw new Error("ffmpeg создал пустой аудиосегмент");
    }
    return { video, audio };
  });
}

/** Изображение → JPEG с длинной стороной не больше `maxSide`. */
export async function resizeImage(input: Buffer, maxSide = 1536): Promise<Buffer> {
  return withTemp(input, async (dir, file) => {
    const out = join(dir, "image.jpg");
    await run(FFMPEG, [
      "-i", file, "-frames:v", "1",
      "-vf", `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`,
      "-q:v", "3", out,
    ]);
    return readFile(out);
  });
}
