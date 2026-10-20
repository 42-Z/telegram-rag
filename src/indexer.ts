/**
 * Единая очередь: сохраняет оригинал в S3, технически готовит сегменты,
 * считает прямые текстовые/мультимодальные векторы и атомарно меняет индекс.
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder, EmbeddingInput } from "./embeddings.ts";
import { chunkHeader, buildChunks } from "./chunks.ts";
import { logger } from "./log.ts";
import { formatMediaSize } from "./media/limits.ts";
import { MEDIA_TYPES, inspectMedia, mediaFileName, mediaModality, prepareMediaChunks, sniffMimeType } from "./media/prepare.ts";
import { type MediaProbe } from "./media/ffmpeg.ts";
import type { PreparedMediaChunk } from "./media/prepare.ts";
import type { ObjectStorage } from "./storage.ts";
import type { IndexedChunk, MediaAsset, MediaAssetReference, MediaJob, Post, Store } from "./store.ts";
import { mediaSourceFingerprint, searchableText } from "./telegram/normalize.ts";

const log = logger("indexer");
const asDocument = (text: string) => ({ type: "text", purpose: "document", text }) as const;

export interface IndexerOptions {
  batchSize: number;
  concurrency: number;
  mediaTypes: readonly string[];
  mediaSince?: Date;
  /**
   * Предел оригинала по явному запросу `get_post`. Фоновая индексация
   * ограничена `maxEmbedBytes`: более крупные файлы догружаются по запросу.
   */
  maxArchiveBytes: number;
  /** Предел размера и длительности для фоновой индексации и векторного поиска. */
  maxEmbedBytes: number;
  maxEmbedSeconds: number;
  segmentSeconds: number;
  segmentOverlapSeconds: number;
  storage?: ObjectStorage;
  downloadMedia?: (channelId: number, messageId: number, expected: MediaJob["media"]) => Promise<Buffer>;
  /** Потоковая загрузка в файл для оригиналов, которые нельзя держать в памяти целиком. */
  downloadMediaToFile?: (
    channelId: number,
    messageId: number,
    expected: MediaJob["media"],
    path: string,
  ) => Promise<void>;
}

interface SavedOriginal {
  asset: MediaAsset;
  bytes: Buffer;
  info: Awaited<ReturnType<typeof inspectMedia>> | undefined;
  skipReason?: string;
}

const EMPTY_PROBE: MediaProbe = { duration: 0, formatName: "", hasAudio: false, hasVideo: false };
const assetRef = (job: Pick<MediaJob, "channelId" | "messageId" | "media">): MediaAssetReference => ({
  channelId: job.channelId,
  messageId: job.messageId,
  sourceFileId: job.media.fileId,
  sourceFingerprint: mediaSourceFingerprint(job.media),
});

export class Indexer {
  private stopped = false;
  private notified = false;
  private wake: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private loopPromise: Promise<void> | undefined;
  private readonly originalTasks = new Map<string, Promise<SavedOriginal | undefined>>();
  private readonly store: Store;
  private readonly embedder: Embedder;
  private readonly options: IndexerOptions;

  constructor(store: Store, embedder: Embedder, options: IndexerOptions) {
    this.store = store;
    this.embedder = embedder;
    this.options = options;
  }

  /** Один проход по очереди. Ошибка одного сообщения не останавливает соседние. */
  async runOnce(): Promise<number> {
    const posts = await this.store.pendingForEmbedding(this.options.batchSize, this.options.mediaTypes);
    if (posts.length === 0) return 0;

    let next = 0;
    const workers = Array.from({ length: Math.min(this.options.concurrency, posts.length) }, async () => {
      while (!this.stopped) {
        const index = next++;
        const post = posts[index];
        if (!post) return;
      try {
        await this.processPost(post);
      } catch (error) {
          const current = await this.store.markEmbedErrorIfCurrent(post, String(error));
          if (current) log.warn(`не проиндексирован пост ${post.channelId}/${post.messageId}`, error);
        }
      }
    });
    await Promise.all(workers);
    return posts.length;
  }

  /**
   * Один оригинал — одна загрузка в каждом режиме. Фоновая очередь и прямой
   * запрос используют разные пределы, поэтому и ключи разные.
   */
  private saveOriginal(job: MediaJob, direct = false): Promise<SavedOriginal | undefined> {
    const source = job.media.fileId ?? mediaSourceFingerprint(job.media);
    const key = `${job.channelId}:${job.messageId}:${source}:${direct ? "direct" : "background"}`;
    const running = this.originalTasks.get(key);
    if (running) return running;
    let task: Promise<SavedOriginal | undefined>;
    task = this.saveOriginalWork(job, direct).finally(() => {
      if (this.originalTasks.get(key) === task) this.originalTasks.delete(key);
    });
    this.originalTasks.set(key, task);
    return task;
  }

  private async saveOriginalWork(job: MediaJob, direct: boolean): Promise<SavedOriginal | undefined> {
    const storage = this.options.storage;
    const download = this.options.downloadMedia;
    const downloadToFile = this.options.downloadMediaToFile;
    if (!storage) throw new Error("S3 storage is required for media archival");

    let asset = await this.store.getMediaAsset(job.channelId, job.messageId);
    if (asset?.storageStatus === "stored" && asset.bucket !== storage.bucket) {
      throw new Error("объект сохранён в другом bucket; автоматический перенос между bucket не выполняется");
    }
    const mediaAssetInput = {
      channelId: job.channelId,
      messageId: job.messageId,
      sourceFileId: job.media.fileId,
      sourceFingerprint: mediaSourceFingerprint(job.media),
      bucket: storage.bucket,
      fileName: job.media.fileName,
      mimeType: job.media.mimeType,
      size: job.media.size,
      duration: job.media.duration,
    };
    if (
      asset?.sourceFileId === (job.media.fileId ?? null) &&
      asset.storageStatus === "stored" &&
      asset.objectKey &&
      (job.media.fileId != null || asset.sourceFingerprint === mediaAssetInput.sourceFingerprint)
    ) {
      asset = await this.store.ensureMediaAsset(mediaAssetInput);
      if (!asset) return undefined;
      if (!asset.objectKey || asset.storageStatus !== "stored") {
        throw new Error("сохранённый оригинал потерял ссылку на объект в S3");
      }

      // Оригинал выше предела поиска не читаем из S3: вектора у него всё равно не будет.
      const storedSize = asset.size ?? job.media.size ?? 0;
      if (storedSize > this.options.maxEmbedBytes) {
        return {
          asset,
          bytes: Buffer.alloc(0),
          info: undefined,
          skipReason: this.tooLargeForEmbedding(storedSize),
        };
      }

      let bytes: Buffer;
      try {
        bytes = await storage.readOriginal(asset.objectKey);
      } catch (error) {
        await this.store.markMediaStorageFailed(assetRef(job), String(error), { allowStored: true });
        throw new Error("не удалось прочитать ранее сохранённый оригинал из S3");
      }
      if (bytes.length > this.options.maxEmbedBytes) {
        return {
          asset,
          bytes: Buffer.alloc(0),
          info: undefined,
          skipReason: this.tooLargeForEmbedding(bytes.length),
        };
      }
      let info: SavedOriginal["info"];
      let skipReason: string | undefined;
      try {
        info = await inspectMedia(bytes, job.media);
      } catch (error) {
        skipReason = `не удалось прочитать медиа для индексации: ${error instanceof Error ? error.message : String(error)}`;
      }
      return { asset, bytes, info, skipReason };
    }

    asset = await this.store.ensureMediaAsset(mediaAssetInput);
    if (!asset) return undefined; // сообщение успели изменить или удалить
    if (!download && !downloadToFile) {
      const reason = "оригинал отсутствует в S3, а Telegram сейчас не подключён";
      await this.store.markMediaStorageFailed(assetRef(job), reason);
      await this.store.markMediaEmbeddingSkipped(assetRef(job), reason);
      return { asset, bytes: Buffer.alloc(0), info: undefined, skipReason: reason };
    }

    // Фоновая очередь не скачивает то, что не попадёт в векторный поиск;
    // явный запрос get_post допускает оригинал до предела архива.
    const downloadLimit = direct ? this.options.maxArchiveBytes : this.options.maxEmbedBytes;
    const claimedSize = job.media.size;
    if (claimedSize && claimedSize > downloadLimit) {
      return this.skipArchiveOversized(job, asset, claimedSize, downloadLimit, direct);
    }

    let tempDir: string | undefined;
    try {
      let bytes: Buffer | undefined;
      let path: string | undefined;
      if (downloadToFile) {
        tempDir = await mkdtemp(join(tmpdir(), "telegram-rag-original-"));
        path = join(tempDir, "original");
        await downloadToFile(job.channelId, job.messageId, job.media, path);
      } else {
        bytes = await download!(job.channelId, job.messageId, job.media);
      }

      const size = path ? (await stat(path)).size : bytes!.length;
      if (size === 0) throw new Error("Telegram отдал пустой файл");
      if (size > downloadLimit) return this.skipArchiveOversized(job, asset, size, downloadLimit, direct);

      if (size > this.options.maxEmbedBytes) {
        // Крупный оригинал сохраняем потоком; MIME из Telegram достаточен,
        // потому что в векторный поиск этот файл уже не попадёт.
        const contentType = job.media.mimeType?.trim() || "application/octet-stream";
        const fileName = mediaFileName(job.media, contentType, job.channelId, job.messageId);
        const stored = path
          ? await storage.saveOriginalFile({ path, contentType, filename: fileName })
          : await storage.saveOriginal({ bytes: bytes!, contentType, filename: fileName });
        const savedAsset = await this.store.saveMediaAssetFile(assetRef(job), {
          bucket: storage.bucket,
          objectKey: stored.key,
          sha256: stored.sha256,
          mimeType: stored.contentType,
          fileName,
          size: stored.size,
          duration: job.media.duration,
        });
        if (!savedAsset) return undefined;
        return {
          asset: savedAsset,
          bytes: Buffer.alloc(0),
          info: undefined,
          skipReason: this.tooLargeForEmbedding(size),
        };
      }

      const data = bytes ?? (await readFile(path!));
      let info: SavedOriginal["info"];
      let skipReason: string | undefined;
      try {
        info = await inspectMedia(data, job.media);
      } catch (error) {
        skipReason = `не удалось прочитать медиа для индексации: ${error instanceof Error ? error.message : String(error)}`;
      }
      const contentType = info?.mimeType ?? sniffMimeType(data, job.media, EMPTY_PROBE);
      const fileName = mediaFileName(job.media, contentType, job.channelId, job.messageId);
      const stored = await storage.saveOriginal({ bytes: data, contentType, filename: fileName });
      const savedAsset = await this.store.saveMediaAssetFile(assetRef(job), {
        bucket: storage.bucket,
        objectKey: stored.key,
        sha256: stored.sha256,
        mimeType: stored.contentType,
        fileName,
        size: stored.size,
        duration: info?.duration ?? job.media.duration,
      });
      if (!savedAsset) return undefined; // не привязываем файл к уже изменённому сообщению
      if (skipReason) await this.store.markMediaEmbeddingSkipped(assetRef(job), skipReason);
      return { asset: savedAsset, bytes: data, info, skipReason };
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
  }

  private tooLargeForEmbedding(size: number): string {
    return `файл ${formatMediaSize(size)} больше предела векторного поиска (${formatMediaSize(this.options.maxEmbedBytes)})`;
  }

  private async skipArchiveOversized(
    job: MediaJob,
    asset: MediaAsset,
    size: number,
    limit: number,
    direct: boolean,
  ): Promise<SavedOriginal> {
    const reason = direct
      ? `файл ${formatMediaSize(size)} превышает предел сохранения (${formatMediaSize(limit)})`
      : `файл ${formatMediaSize(size)} больше предела фоновой индексации (${formatMediaSize(limit)}); доступен по прямому запросу get_post`;
    await this.store.markMediaStorageSkipped(assetRef(job), reason);
    await this.store.markMediaEmbeddingSkipped(assetRef(job), reason);
    return { asset, bytes: Buffer.alloc(0), info: undefined, skipReason: reason };
  }

  private async processPost(post: Awaited<ReturnType<Store["pendingForEmbedding"]>>[number]): Promise<void> {
    const media = post.media;
    const mediaJob: MediaJob | undefined = media
      ? { channelId: post.channelId, messageId: post.messageId, date: new Date(post.date), text: post.text, media }
      : undefined;
    const mediaSelected = Boolean(media && this.options.mediaTypes.includes(media.type));

    let original: SavedOriginal | undefined;
    if (mediaSelected && mediaJob) {
      try {
        original = await this.saveOriginal(mediaJob);
        if (!original) return; // сообщение успели изменить или удалить
      } catch (error) {
        // Сбой скачивания, S3 или чтения оригинала касается только вложения: пометим его
        // для повтора (`retry-failed`), а текст поста проиндексируем как обычно.
        await this.store.markMediaStorageFailed(assetRef(mediaJob), String(error));
        log.warn(`вложение ${post.channelId}/${post.messageId} не сохранено`, error);
      }
    }

    const mediaSkipReason = original && mediaJob
      ? original.skipReason ?? this.embeddingSkipReason(mediaJob, original)
      : undefined;
    if (mediaSkipReason && mediaJob) {
      await this.store.markMediaEmbeddingSkipped(assetRef(mediaJob), mediaSkipReason);
    }

    const text = searchableText(post);
    const textChunks = buildChunks({ channelTitle: post.channelTitle, date: new Date(post.date), text });
    const chunks: IndexedChunk[] = [];

    if (textChunks.length > 0) {
      const vectors = await this.embedder.embed(textChunks.map(asDocument));
      if (vectors.length !== textChunks.length) throw new Error("Embedding endpoint returned an unexpected number of text vectors");
      textChunks.forEach((content, index) => chunks.push({ kind: "text", content, embedding: vectors[index]! }));
    }

    if (original && mediaJob && !mediaSkipReason) {
      // Остановка посреди длинного файла: пост остаётся в очереди, ничего не записываем.
      if ((await this.appendMediaVectors(post, original, chunks)) === "stopped") return;
    }

    await this.store.replaceChunks(post, chunks);
  }

  private embeddingSkipReason(job: MediaJob, original: SavedOriginal): string | undefined {
    const modality = mediaModality(job.media.type);
    if (!modality || !this.embedder.modalities.has(modality)) {
      // Оригинал уже в S3 и отдаётся вместе с постом; вектора у такого вложения нет.
      return `модель ${this.embedder.model} не принимает ${modality ?? job.media.type}`;
    }
    if (this.options.mediaSince && job.date < this.options.mediaSince) {
      return `дата раньше MEDIA_SINCE (${this.options.mediaSince.toISOString()})`;
    }
    const size = original.asset.size ?? original.bytes.length;
    if (size > this.options.maxEmbedBytes) return this.tooLargeForEmbedding(size);
    const duration = original.info?.duration ?? job.media.duration ?? 0;
    if (duration > this.options.maxEmbedSeconds) {
      return `длительность ${duration} секунд больше предела векторного поиска (${this.options.maxEmbedSeconds} секунд)`;
    }
    return undefined;
  }

  /**
   * Догружает оригинал поста по явному запросу, не дожидаясь очереди.
   * Предел архива — 2048 МиБ; вектор появится позже, если вложение
   * укладывается в предел векторного поиска.
   */
  async ensureOriginal(post: Post): Promise<void> {
    const media = post.media;
    if (!media || !MEDIA_TYPES.includes(media.type) || !this.options.storage) return;
    if (!this.options.downloadMedia && !this.options.downloadMediaToFile) return;
    const job: MediaJob = {
      channelId: post.channelId,
      messageId: post.messageId,
      date: new Date(post.date),
      text: post.text,
      media,
    };
    try {
      const asset = await this.store.getMediaAsset(post.channelId, post.messageId);
      if (asset?.storageStatus === "stored") return;
      const original = await this.saveOriginal(job, true);
      if (!original) return;
      const skipReason = original.skipReason ?? this.embeddingSkipReason(job, original);
      if (skipReason) {
        await this.store.markMediaEmbeddingSkipped(assetRef(job), skipReason);
      } else {
        // Оригинал появился у уже проиндексированного поста — будим очередь.
        this.notify();
      }
    } catch (error) {
      await this.store.markMediaStorageFailed(assetRef(job), String(error));
      log.warn(`вложение ${post.channelId}/${post.messageId} не сохранено по прямому запросу`, error);
    }
  }

  /**
   * Добавляет в `chunks` векторы всех сегментов вложения — либо ни одного: частично
   * подготовленный файл не должен выглядеть проиндексированным. Сбой вложения только
   * помечает его (`skipped` для неподготовленного медиа, `failed` для ошибки эмбеддинга) и
   * не мешает записать текстовые векторы поста.
   */
  private async appendMediaVectors(
    post: Awaited<ReturnType<Store["pendingForEmbedding"]>>[number],
    original: SavedOriginal,
    chunks: IndexedChunk[],
  ): Promise<"done" | "skipped" | "failed" | "stopped"> {
    if (!original.info) return "skipped";
    const reference = assetRef({ channelId: post.channelId, messageId: post.messageId, media: post.media! });
    const iterator = prepareMediaChunks(original.bytes, post.media!, original.info, {
      windowSeconds: this.options.segmentSeconds,
      overlapSeconds: this.options.segmentOverlapSeconds,
    });
    const context = [
      chunkHeader(post.channelTitle, new Date(post.date)),
      searchableText(post),
    ].filter(Boolean).join("\n\n");

    const mediaChunks: IndexedChunk[] = [];
    const iterable = iterator[Symbol.asyncIterator]();
    while (true) {
      if (this.stopped) return "stopped";
      let next: IteratorResult<PreparedMediaChunk>;
      try {
        next = await iterable.next();
      } catch (error) {
        const reason = `не удалось подготовить медиа: ${error instanceof Error ? error.message : String(error)}`;
        await this.store.markMediaEmbeddingSkipped(reference, reason);
        return "skipped";
      }
      if (next.done) break;
      try {
        const [embedding] = await this.embedder.embed([{
          type: "multimodal",
          parts: [{ type: "text", text: context || "" }, ...next.value.parts],
        }]);
        if (!embedding) throw new Error("Embedding endpoint returned no vector for media");
        const asset = await this.store.getMediaAsset(post.channelId, post.messageId);
        if (!asset || asset.storageStatus !== "stored") throw new Error("Saved media asset disappeared before indexing");
        mediaChunks.push({
          kind: next.value.kind,
          mediaAssetId: asset.assetId,
          startSeconds: next.value.startSeconds,
          endSeconds: next.value.endSeconds,
          embedding,
        });
      } catch (error) {
        await this.store.markMediaEmbeddingFailed(reference, String(error));
        log.warn(`вложение ${post.channelId}/${post.messageId} не проиндексировано`, error);
        return "failed";
      }
    }
    chunks.push(...mediaChunks);
    return "done";
  }

  start(idleMs = 60_000): void {
    if (this.loopPromise) return;
    this.stopped = false;
    this.loopPromise = this.loop(idleMs);
  }

  private async loop(idleMs: number): Promise<void> {
    while (!this.stopped) {
      this.notified = false;
      let processed = 0;
      try {
        processed = await this.runOnce();
      } catch (error) {
        log.error("единая очередь индексации упала, повтор позже", error);
      }
      if (this.stopped) break;
      if (processed > 0) continue;
      if (this.notified) continue;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, idleMs);
        if (this.notified) resolve();
      });
      clearTimeout(this.timer);
      this.timer = undefined;
      this.wake = undefined;
    }
  }

  notify(): void {
    this.notified = true;
    this.wake?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.wake?.();
    await this.loopPromise;
    this.loopPromise = undefined;
  }
}
