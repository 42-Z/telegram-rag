/**
 * Подготовка медиа для модели через ffmpeg: звук → mp3 (моно, 16 кГц —
 * речи хватает, а запрос в разы меньше), видео → несколько кадров JPEG.
 * Работа идёт через временные файлы: mp4 из Telegram не всегда читается
 * из потока (оглавление файла бывает в конце).
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

function run(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      reject(new Error(`ffmpeg не запустился (${error.message}) — установите ffmpeg или задайте FFMPEG_PATH`)),
    );
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${stderr.trim() || `код ${code}`}`))));
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

/** Звуковая дорожка в mp3. `null` — звука в файле нет. */
export async function toMp3(input: Buffer): Promise<Buffer | null> {
  return withTemp(input, async (dir, file) => {
    const out = join(dir, "audio.mp3");
    try {
      await run(["-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", out]);
    } catch (error) {
      if (/does not contain any stream|matches no streams|Output file.*empty/i.test(String(error))) return null;
      throw error;
    }
    const audio = await readFile(out);
    return audio.length > 0 ? audio : null;
  });
}

/** `count` кадров, равномерно по длительности, длинная сторона — 768 точек. */
export async function extractFrames(input: Buffer, durationSeconds: number, count: number): Promise<Buffer[]> {
  return withTemp(input, async (dir, file) => {
    const frames: Buffer[] = [];
    const duration = Math.max(durationSeconds, 0.1);
    for (let i = 0; i < count; i += 1) {
      const at = ((i + 0.5) * duration) / count;
      const out = join(dir, `frame-${i}.jpg`);
      try {
        await run([
          "-ss", at.toFixed(2), "-i", file, "-frames:v", "1",
          "-vf", "scale='if(gt(iw,ih),768,-2)':'if(gt(iw,ih),-2,768)'", "-q:v", "4", out,
        ]);
        const frame = await readFile(out);
        if (frame.length > 0) frames.push(frame);
      } catch {
        // кадр за концом короткого ролика — пропускается
      }
    }
    return frames;
  });
}

/** Изображение → JPEG с длинной стороной не больше `maxSide`. */
export async function resizeImage(input: Buffer, maxSide = 1536): Promise<Buffer> {
  return withTemp(input, async (dir, file) => {
    const out = join(dir, "image.jpg");
    await run([
      "-i", file, "-frames:v", "1",
      "-vf", `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`,
      "-q:v", "3", out,
    ]);
    return readFile(out);
  });
}
