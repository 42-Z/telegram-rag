/** Technical media preparation only: probing, bounded re-encoding and segmentation. */

import type { EmbeddingPart, Modality } from "../embeddings.ts";
import type { ChunkKind } from "../store.ts";
import type { PostMedia } from "../telegram/normalize.ts";
import { extractMediaSegment, prepareImage, probeMedia, type MediaProbe } from "./ffmpeg.ts";

export interface PreparedMediaChunk {
  kind: Exclude<ChunkKind, "text">;
  parts: readonly EmbeddingPart[];
  startSeconds: number | null;
  endSeconds: number | null;
}

export interface PreparedMediaInfo {
  mimeType: string;
  duration: number | undefined;
  probe: MediaProbe;
}

export interface MediaPreparationOptions {
  windowSeconds: number;
  overlapSeconds: number;
  maxImageSide?: number;
}

const mimeByExtension: Record<string, string> = {
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  wav: "audio/wav",
  webm: "video/webm",
  gif: "image/gif",
};

/** Какую модальность модели нужно уметь, чтобы построить вектор для вложения этого типа. */
const modalityByMediaType = {
  photo: "image",
  voice: "audio",
  audio: "audio",
  video: "video",
  video_note: "video",
  gif: "video",
} as const satisfies Record<string, Modality>;

/** Все типы вложений, которые сохраняются в S3; векторы строятся только для поддерживаемых моделью. */
export const MEDIA_TYPES: readonly string[] = Object.keys(modalityByMediaType);

export function mediaModality(mediaType: string): Modality | undefined {
  return (modalityByMediaType as Record<string, Modality>)[mediaType];
}

export function sniffMimeType(bytes: Buffer, media: PostMedia, probe: MediaProbe): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") {
    return "audio/wav";
  }
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) {
    return "audio/mpeg";
  }
  if (probe.hasVideo) {
    if (/webm/i.test(probe.formatName)) return "video/webm";
    if (/matroska/i.test(probe.formatName)) return "video/x-matroska";
    if (/mov|mp4|3gp|m4a/i.test(probe.formatName)) return "video/mp4";
  }
  if (probe.hasAudio) {
    if (/ogg/i.test(probe.formatName)) return "audio/ogg";
    if (/wav|wave/i.test(probe.formatName)) return "audio/wav";
    if (/mp3|mp2/i.test(probe.formatName)) return "audio/mpeg";
  }
  if (media.mimeType?.trim()) return media.mimeType;
  const extension = media.fileName?.split(".").at(-1)?.toLowerCase();
  return extension ? mimeByExtension[extension] ?? "application/octet-stream" : "application/octet-stream";
}

export function mediaFileName(media: PostMedia, mimeType: string, channelId: number, messageId: number): string {
  if (media.fileName?.trim()) return media.fileName.trim();
  const extension = Object.entries(mimeByExtension).find(([, mime]) => mime === mimeType)?.[0] ?? "bin";
  return `${channelId}-${messageId}.${extension}`;
}

export async function inspectMedia(bytes: Buffer, media: PostMedia): Promise<PreparedMediaInfo> {
  const probe = await probeMedia(bytes);
  return {
    mimeType: sniffMimeType(bytes, media, probe),
    duration: probe.duration > 0 ? probe.duration : media.duration,
    probe,
  };
}

function* windows(duration: number, seconds: number, overlap: number): Generator<{ start: number; end: number }> {
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(overlap) || overlap < 0 || overlap >= seconds) {
    throw new TypeError("segment overlap must be non-negative and smaller than the segment duration");
  }
  let start = 0;
  while (start < duration) {
    const end = Math.min(start + seconds, duration);
    if (end <= start) return;
    yield { start, end };
    if (end >= duration) return;
    start = end - overlap;
  }
}

export async function* prepareMediaChunks(
  bytes: Buffer,
  media: PostMedia,
  info: PreparedMediaInfo,
  options: MediaPreparationOptions,
): AsyncGenerator<PreparedMediaChunk> {
  if (media.type === "photo" || (media.type !== "gif" && info.mimeType.startsWith("image/"))) {
    if (!info.probe.hasVideo) throw new Error("не удалось прочитать изображение");
    const image = await prepareImage(bytes, info.mimeType, info.probe, options.maxImageSide);
    yield {
      kind: "image",
      parts: [{ type: "image", mimeType: image.mimeType, data: image.bytes }],
      startSeconds: null,
      endSeconds: null,
    };
    return;
  }

  const videoRequested = ["video", "video_note", "gif"].includes(media.type);
  const audioRequested = ["voice", "audio"].includes(media.type);
  const hasVideo = videoRequested && info.probe.hasVideo;
  const hasAudio = audioRequested ? info.probe.hasAudio : videoRequested && info.probe.hasAudio;
  if (!hasVideo && !hasAudio) {
    throw new Error("в исходном файле нет поддерживаемого аудио- или видеопотока");
  }
  const duration = info.duration;
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("ffprobe не смог определить длительность медиа");
  }

  for (const range of windows(duration, options.windowSeconds, options.overlapSeconds)) {
    const segment = await extractMediaSegment(bytes, range.start, range.end - range.start, {
      video: hasVideo,
      audio: hasAudio,
    });
    const parts: EmbeddingPart[] = [];
    if (segment.video) parts.push({ type: "video", mimeType: "video/mp4", data: segment.video });
    if (segment.audio) parts.push({ type: "audio", mimeType: "audio/wav", data: segment.audio });
    if (parts.length === 0) throw new Error("ffmpeg не подготовил данные сегмента");
    yield {
      kind: hasVideo ? "video" : "audio",
      parts,
      startSeconds: range.start,
      endSeconds: range.end,
    };
  }
}
