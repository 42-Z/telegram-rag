/**
 * Единая очередь: сохраняет оригинал в S3, технически готовит сегменты,
 * считает прямые текстовые/мультимодальные векторы и атомарно меняет индекс.
 */

import type { Embedder, EmbeddingInput } from "./embeddings.ts";
import { chunkHeader, buildChunks } from "./chunks.ts";
import { logger } from "./log.ts";
import { inspectMedia, mediaFileName, mediaModality, prepareMediaChunks, sniffMimeType } from "./media/prepare.ts";
import { type MediaProbe } from "./media/ffmpeg.ts";
import type { PreparedMediaChunk } from "./media/prepare.ts";
import type { ObjectStorage } from "./storage.ts";
import type { MediaAsset, MediaAssetReference, MediaJob, Store } from "./store.ts";
import { mediaSourceFingerprint, searchableText } from "./telegram/normalize.ts";

const log = logger("indexer");
const asDocument = (text: string) => ({ type: "text", purpose: "document", text }) as const;

export interface IndexerOptions {
  batchSize: number;
  concurrency: number;
  mediaTypes: readonly string[];
  mediaSince?: Date;
  maxMediaBytes: number;
  maxMediaSeconds: number;
  segmentSeconds: number;
  segmentOverlapSeconds: number;
  storage?: ObjectStorage;
  downloadMedia?: (channelId: number, messageId: number, expected: MediaJob["media"]) => Promise<Buffer>;
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

  private async saveOriginal(job: MediaJob): Promise<SavedOriginal | undefined> {
    const storage = this.options.storage;
    const download = this.options.downloadMedia;
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
      let bytes: Buffer;
      try {
        bytes = await storage.readOriginal(asset.objectKey);
      } catch (error) {
        await this.store.markMediaStorageFailed(assetRef(job), String(error));
        throw new Error("не удалось прочитать ранее сохранённый оригинал из S3");
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
    if (!download) {
      const reason = "оригинал отсутствует в S3, а Telegram сейчас не подключён";
      await this.store.markMediaStorageFailed(assetRef(job), reason);
      await this.store.markMediaEmbeddingSkipped(assetRef(job), reason);
      return { asset, bytes: Buffer.alloc(0), info: undefined, skipReason: reason };
    }

    const bytes = await download(job.channelId, job.messageId, job.media);
    if (bytes.length === 0) throw new Error("Telegram отдал пустой файл");
    if (bytes.length > this.options.maxMediaBytes) {
      const reason = `файл ${(bytes.length / 1_048_576).toFixed(1)} МБ превышает MEDIA_MAX_MB`;
      await this.store.markMediaStorageSkipped(assetRef(job), reason);
      await this.store.markMediaEmbeddingSkipped(assetRef(job), reason);
      return { asset, bytes, info: undefined, skipReason: reason };
    }

    let info: SavedOriginal["info"];
    let skipReason: string | undefined;
    try {
      info = await inspectMedia(bytes, job.media);
    } catch (error) {
      skipReason = `не удалось прочитать медиа для индексации: ${error instanceof Error ? error.message : String(error)}`;
    }
    const contentType = info?.mimeType ?? sniffMimeType(bytes, job.media, EMPTY_PROBE);
    const fileName = mediaFileName(job.media, contentType, job.channelId, job.messageId);
    const stored = await storage.saveOriginal({ bytes, contentType, filename: fileName });
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
    return { asset: savedAsset, bytes, info, skipReason };
  }

  private async processPost(post: Awaited<ReturnType<Store["pendingForEmbedding"]>>[number]): Promise<void> {
    const media = post.media;
    const mediaJob: MediaJob | undefined = media
      ? { channelId: post.channelId, messageId: post.messageId, date: new Date(post.date), text: post.text, media }
      : undefined;
    const mediaSelected = Boolean(media && this.options.mediaTypes.includes(media.type));
    const original = mediaSelected && mediaJob ? await this.saveOriginal(mediaJob) : undefined;
    if (mediaSelected && !original) return; // сообщение успели изменить или удалить

    let mediaSkipReason = original?.skipReason;
    if (mediaSkipReason && mediaJob) {
      await this.store.markMediaEmbeddingSkipped(assetRef(mediaJob), mediaSkipReason);
    }
    if (original && mediaJob && !mediaSkipReason) {
      const modality = mediaModality(mediaJob.media.type);
      const tooOld = this.options.mediaSince && new Date(post.date) < this.options.mediaSince;
      const tooLong = (original.info?.duration ?? media?.duration ?? 0) > this.options.maxMediaSeconds;
      if (!modality || !this.embedder.modalities.has(modality)) {
        // Оригинал уже в S3 и отдаётся вместе с постом; вектора у такого вложения нет.
        mediaSkipReason = `модель ${this.embedder.model} не принимает ${modality ?? mediaJob.media.type}`;
      } else if (tooOld) {
        mediaSkipReason = `дата раньше MEDIA_SINCE (${this.options.mediaSince!.toISOString()})`;
      } else if (tooLong) {
        mediaSkipReason = `длительность больше MEDIA_MAX_SECONDS (${this.options.maxMediaSeconds})`;
      }
      if (mediaSkipReason) await this.store.markMediaEmbeddingSkipped(assetRef(mediaJob), mediaSkipReason);
    }

    const text = searchableText(post);
    const textChunks = buildChunks({ channelTitle: post.channelTitle, date: new Date(post.date), text });
    const chunks = [] as Array<{
      kind: "text" | "image" | "audio" | "video";
      content?: string | null;
      mediaAssetId?: number | null;
      startSeconds?: number | null;
      endSeconds?: number | null;
      embedding: readonly number[];
    }>;

    if (textChunks.length > 0) {
      const vectors = await this.embedder.embed(textChunks.map(asDocument));
      if (vectors.length !== textChunks.length) throw new Error("Embedding endpoint returned an unexpected number of text vectors");
      textChunks.forEach((content, index) => chunks.push({ kind: "text", content, embedding: vectors[index]! }));
    }

    if (original && mediaJob && !mediaSkipReason) {
      await this.appendMediaVectors(post, original, chunks);
    }

    await this.store.replaceChunks(post, chunks);
  }

  private async appendMediaVectors(
    post: Awaited<ReturnType<Store["pendingForEmbedding"]>>[number],
    original: SavedOriginal,
    chunks: Array<{
      kind: "text" | "image" | "audio" | "video";
      content?: string | null;
      mediaAssetId?: number | null;
      startSeconds?: number | null;
      endSeconds?: number | null;
      embedding: readonly number[];
    }>,
  ): Promise<void> {
    if (!original.info) return;
    const iterator = prepareMediaChunks(original.bytes, post.media!, original.info, {
      windowSeconds: this.options.segmentSeconds,
      overlapSeconds: this.options.segmentOverlapSeconds,
    });
    const context = [
      chunkHeader(post.channelTitle, new Date(post.date)),
      searchableText(post),
    ].filter(Boolean).join("\n\n");

    const iterable = iterator[Symbol.asyncIterator]();
    while (true) {
      let next: IteratorResult<PreparedMediaChunk>;
      try {
        next = await iterable.next();
      } catch (error) {
        const reason = `не удалось подготовить медиа: ${error instanceof Error ? error.message : String(error)}`;
        await this.store.markMediaEmbeddingSkipped(assetRef({
          channelId: post.channelId,
          messageId: post.messageId,
          media: post.media!,
        }), reason);
        return;
      }
      if (next.done) return;
      const [embedding] = await this.embedder!.embed([{
        type: "multimodal",
        parts: [{ type: "text", text: context || "" }, ...next.value.parts],
      }]);
      if (!embedding) throw new Error("Embedding endpoint returned no vector for media");
      const asset = await this.store.getMediaAsset(post.channelId, post.messageId);
      if (!asset || asset.storageStatus !== "stored") throw new Error("Saved media asset disappeared before indexing");
      chunks.push({
        kind: next.value.kind,
        mediaAssetId: asset.assetId,
        startSeconds: next.value.startSeconds,
        endSeconds: next.value.endSeconds,
        embedding,
      });
    }
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
