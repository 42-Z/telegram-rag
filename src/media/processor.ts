/**
 * Очередь разбора медиа: фото, голосовые, кружки (и по желанию — аудио,
 * видео, GIF). Для каждого поста: скачать файл из Telegram → подготовить
 * (ffmpeg) → отдать мультимодальной модели → сохранить текст. Текст ложится
 * рядом с постом, и индексатор сам пересчитывает его эмбеддинги.
 *
 * Итог всегда записывается: done — разобрано, skipped — сознательно не
 * разбиралось (слишком большое/длинное), failed — ошибка (повтор —
 * POST /api/admin/retry-failed). Поэтому очередь не застревает на одном посте.
 */

import { logger } from "../log.ts";
import type { MediaJob, Store } from "../store.ts";
import { type MediaAnalyzer, mediaText } from "./analyzer.ts";
import { extractFrames, resizeImage, toMp3 } from "./ffmpeg.ts";

const log = logger("media");

export type MediaDownloader = (channelId: number, messageId: number) => Promise<Buffer>;

export interface MediaOptions {
  types: readonly string[];
  since?: Date;
  maxBytes: number;
  maxSeconds: number;
  concurrency: number;
  onDone?: () => void;
}

const FRAMES: Record<string, number> = { video_note: 3, video: 4, gif: 3 };
const AUDIO_TYPES = new Set(["voice", "audio"]);

export class MediaProcessor {
  private readonly store: Store;
  private readonly analyzer: MediaAnalyzer;
  private readonly download: MediaDownloader;
  private readonly options: MediaOptions;
  private readonly inFlight = new Set<string>();
  private wake: (() => void) | undefined;
  private stopped = false;

  constructor(store: Store, analyzer: MediaAnalyzer, download: MediaDownloader, options: MediaOptions) {
    this.store = store;
    this.analyzer = analyzer;
    this.download = download;
    this.options = options;
  }

  /** Разбирает один пост и записывает итог. */
  async process(job: MediaJob): Promise<void> {
    const where = `${job.channelId}/${job.messageId} (${job.media.type})`;
    const { size, duration } = job.media;
    if (size && size > this.options.maxBytes) {
      await this.skip(job, `файл ${(size / 1_048_576).toFixed(1)} МБ больше MEDIA_MAX_MB`);
      return;
    }
    if (duration && duration > this.options.maxSeconds) {
      await this.skip(job, `длительность ${Math.round(duration)} с больше MEDIA_MAX_SECONDS`);
      return;
    }
    try {
      const file = await this.download(job.channelId, job.messageId);
      if (file.length === 0) throw new Error("Telegram отдал пустой файл");
      if (file.length > this.options.maxBytes) {
        await this.skip(job, `файл ${(file.length / 1_048_576).toFixed(1)} МБ больше MEDIA_MAX_MB`);
        return;
      }

      const type = job.media.type;
      let images: Buffer[] = [];
      let audio: Buffer | null = null;
      if (type === "photo") images = [await resizeImage(file)];
      else if (AUDIO_TYPES.has(type)) audio = await toMp3(file);
      else {
        images = await extractFrames(file, duration ?? 1, FRAMES[type] ?? 3);
        if (type !== "gif") audio = await toMp3(file);
      }
      if (images.length === 0 && !audio) {
        await this.skip(job, "в файле нет ни изображения, ни звука");
        return;
      }

      const analysis = await this.analyzer.analyze({ type, images, audio, caption: job.text });
      const text = mediaText(type, duration, analysis);
      await this.store.saveMediaResult(job, { status: "done", analysis, text });
      log.info(`разобрано ${where}: ${text ? `${text.length} знаков` : "пусто"}`);
      this.options.onDone?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.saveMediaResult(job, { status: "failed", analysis: null, text: null, error: message });
      log.warn(`не разобрано ${where}`, message);
    }
  }

  private async skip(job: MediaJob, note: string): Promise<void> {
    await this.store.saveMediaResult(job, { status: "skipped", analysis: { note }, text: null });
    log.info(`пропущено ${job.channelId}/${job.messageId}: ${note}`);
  }

  /** Один проход: до `concurrency` постов параллельно. */
  async runOnce(): Promise<number> {
    const jobs = (await this.store.pendingMedia(this.options.types, this.options.since, this.options.concurrency * 2))
      .filter((job) => !this.inFlight.has(`${job.channelId}:${job.messageId}`))
      .slice(0, this.options.concurrency);
    await Promise.all(
      jobs.map(async (job) => {
        const key = `${job.channelId}:${job.messageId}`;
        this.inFlight.add(key);
        try {
          await this.process(job);
        } finally {
          this.inFlight.delete(key);
        }
      }),
    );
    return jobs.length;
  }

  start(idleMs = 10_000): void {
    const loop = async () => {
      while (!this.stopped) {
        let processed = 0;
        try {
          processed = await this.runOnce();
        } catch (error) {
          log.error("очередь медиа упала, повтор позже", error);
        }
        if (processed > 0) continue;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, idleMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = undefined;
      }
    };
    void loop();
  }

  notify(): void {
    this.wake?.();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }
}
