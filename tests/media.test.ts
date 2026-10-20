import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Embedder, EmbeddingInput } from "../src/embeddings.ts";
import { Indexer, type IndexerOptions } from "../src/indexer.ts";
import { presentPostMedia } from "../src/presentation.ts";
import type { ObjectStorage, SaveOriginalInput, StoredOriginal } from "../src/storage.ts";
import { mediaSourceFingerprint, normalizeMessage, type PostMedia } from "../src/telegram/normalize.ts";
import { fakeEmbedder, freshStore, message } from "./helpers.ts";

// Подмена подготовки медиа нужна одному тесту: ffmpeg сложно заставить упасть на середине файла.
const prepareHook = vi.hoisted(() => ({ override: undefined as undefined | ((...args: any[]) => AsyncGenerator<any>) }));
vi.mock("../src/media/prepare.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/media/prepare.ts")>();
  return {
    ...actual,
    prepareMediaChunks: (...args: Parameters<typeof actual.prepareMediaChunks>) =>
      prepareHook.override ? prepareHook.override(...args) : actual.prepareMediaChunks(...args),
  };
});
afterEach(() => {
  prepareHook.override = undefined;
});

const dir = mkdtempSync(join(tmpdir(), "telegram-rag-media-test-"));
function generate(name: string, args: string[]): Buffer {
  const out = join(dir, name);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  return readFileSync(out);
}

const voice = generate("voice.ogg", ["-f", "lavfi", "-i", "sine=frequency=440:duration=2.4", "-c:a", "libopus"]);
const video = generate("video.mp4", [
  "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2.5",
  "-f", "lavfi", "-i", "sine=frequency=300:duration=2.5",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
]);
const silentVideo = generate("silent.mp4", [
  "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=1.2",
  "-c:v", "libx264", "-pix_fmt", "yuv420p",
]);
const photo = generate("photo.png", ["-f", "lavfi", "-i", "testsrc=size=640x480", "-frames:v", "1"]);
const gif = generate("animated.gif", [
  "-f", "lavfi", "-i", "testsrc=size=160x120:rate=5:duration=1.8",
  "-vf", "format=rgb8", "-loop", "0", "-f", "gif",
]);
const audio = generate("audio.mp3", ["-f", "lavfi", "-i", "sine=frequency=600:duration=1.5", "-c:a", "libmp3lame"]);

const files: Record<number, Buffer> = { 1: voice, 2: photo, 3: video, 4: silentVideo, 5: gif, 6: audio };
const mediaFor = (type: string, fileId: number, mimeType: string, duration: number, fileName: string) => ({
  ...(type === "photo"
    ? { className: "MessageMediaPhoto", photo: { id: { toString: () => String(fileId) } } }
    : {
        className: "MessageMediaDocument",
        document: {
          id: { toString: () => String(fileId) },
          mimeType,
          size: files[fileId]?.byteLength ?? 100,
          attributes: [
            { className: "DocumentAttributeFilename", fileName },
            ...(type === "voice" ? [{ className: "DocumentAttributeAudio", voice: true, duration }] : []),
            ...(type === "audio" ? [{ className: "DocumentAttributeAudio", duration, title: "тон" }] : []),
            ...(type === "video_note" ? [{ className: "DocumentAttributeVideo", roundMessage: true, duration }] : []),
            ...(type === "video" ? [{ className: "DocumentAttributeVideo", duration }] : []),
            ...(type === "gif" ? [{ className: "DocumentAttributeAnimated" }, { className: "DocumentAttributeVideo", duration }] : []),
          ],
        },
      }),
});

function makeStorage() {
  const objects = new Map<string, { bytes: Buffer; mimeType: string }>();
  const storage: ObjectStorage = {
    bucket: "test-media",
    async saveOriginal(input: SaveOriginalInput): Promise<StoredOriginal> {
      const sha256 = createHash("sha256").update(input.bytes).digest("hex");
      const key = `sha256/${sha256}`;
      const bytes = Buffer.from(input.bytes);
      objects.set(key, { bytes, mimeType: input.contentType });
      return { key, sha256, size: bytes.byteLength, contentType: input.contentType };
    },
    async saveOriginalFile(input) {
      const bytes = readFileSync(input.path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const key = `sha256/${sha256}`;
      objects.set(key, { bytes, mimeType: input.contentType });
      return { key, sha256, size: bytes.byteLength, contentType: input.contentType };
    },
    async readOriginal(key) {
      const object = objects.get(key);
      if (!object) throw new Error("missing test object");
      return Buffer.from(object.bytes);
    },
    async signGet(key) {
      return { url: `https://objects.example.test/${key}?signed=1`, expiresIn: 60, expiresAt: new Date(Date.now() + 60_000) };
    },
    async close() {},
  };
  return { storage, objects };
}

function indexerOptions(
  storage: ObjectStorage,
  download: (id: number, media: PostMedia) => Promise<Buffer>,
  overrides: Partial<IndexerOptions> = {},
) {
  return {
    batchSize: 64,
    concurrency: 2,
    mediaTypes: ["photo", "voice", "video_note", "audio", "video", "gif"],
    maxArchiveBytes: 20 * 1_048_576,
    maxEmbedBytes: 20 * 1_048_576,
    maxEmbedSeconds: 1800,
    segmentSeconds: 1,
    segmentOverlapSeconds: 0.25,
    storage,
    downloadMedia: async (_channelId: number, messageId: number, expected: PostMedia) => download(messageId, expected),
    ...overrides,
  };
}

describe("direct media embedding pipeline", () => {
  it("stores unchanged originals and creates separate typed vectors with aligned time ranges", async () => {
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9001, ref: "@media", username: "media", title: "Медиа", about: null, accessHash: "1" });
      await store.upsertPosts([
        normalizeMessage(9001, message(1, "", { media: mediaFor("voice", 1, "audio/ogg", 2.4, "voice.ogg") })),
        normalizeMessage(9001, message(2, "Подпись фото", { media: mediaFor("photo", 2, "image/png", 0, "photo.png") })),
        normalizeMessage(9001, message(3, "Звук и изображение", { media: mediaFor("video", 3, "video/mp4", 2.5, "video.mp4") })),
        normalizeMessage(9001, message(4, "Немое видео", { media: mediaFor("video", 4, "video/mp4", 1.2, "silent.mp4") })),
        normalizeMessage(9001, message(5, "Анимация", { media: mediaFor("gif", 5, "image/gif", 1.8, "animated.gif") })),
        normalizeMessage(9001, message(6, "Аудиотрек", { media: mediaFor("audio", 6, "audio/mpeg", 1.5, "audio.mp3") })),
        normalizeMessage(9001, message(7, "Обычный текст без файла")),
      ]);
      const { storage, objects } = makeStorage();
      const base = fakeEmbedder();
      const seen: EmbeddingInput[] = [];
      const embedder: Embedder = {
        model: base.model,
        dimensions: base.dimensions,
        modalities: base.modalities,
        async embed(inputs) {
          seen.push(...inputs);
          return base.embed(inputs);
        },
      };
      const indexer = new Indexer(store, embedder, indexerOptions(storage, async (id) => files[id]!));

      expect(await indexer.runOnce()).toBe(7);
      expect(await store.indexStats()).toMatchObject({ posts: 7, indexed: 7, pending: 0, failed: 0 });

      for (const [messageId, original] of Object.entries(files)) {
        const asset = await store.getMediaAsset(9001, Number(messageId));
        expect(asset).toMatchObject({ storageStatus: "stored", embeddingStatus: "done" });
        expect(objects.get(asset!.objectKey!)?.bytes).toEqual(original);
      }

      const chunkRows = await db.query<{
        messageId: number;
        kind: string;
        startSeconds: number | null;
        endSeconds: number | null;
        content: string | null;
      }>(
        `SELECT message_id AS "messageId", kind, start_seconds AS "startSeconds",
           end_seconds AS "endSeconds", content FROM chunks ORDER BY message_id, chunk_index`,
      );
      expect(chunkRows.some((row) => row.messageId === 1 && row.kind === "audio")).toBe(true);
      expect(chunkRows.some((row) => row.messageId === 2 && row.kind === "image")).toBe(true);
      expect(chunkRows.filter((row) => row.messageId === 3 && row.kind === "video").length).toBeGreaterThan(1);
      expect(chunkRows.filter((row) => row.messageId === 3 && row.kind === "video").every((row) => row.content === null)).toBe(true);
      expect(chunkRows.filter((row) => row.messageId === 3 && row.kind === "video").some((row) => row.startSeconds === 0 && row.endSeconds === 1)).toBe(true);

      const videoInput = seen.find((input) => input.type === "multimodal" && input.parts.some((part) => part.type === "text" && part.text.includes("Звук и изображение")));
      expect(videoInput?.type).toBe("multimodal");
      if (videoInput?.type === "multimodal") expect(videoInput.parts.map((part) => part.type)).toContain("audio");
      const silentInput = seen.find((input) => input.type === "multimodal" && input.parts.some((part) => part.type === "text" && part.text.includes("Немое видео")));
      expect(silentInput?.type).toBe("multimodal");
      if (silentInput?.type === "multimodal") expect(silentInput.parts.map((part) => part.type)).not.toContain("audio");
      const imageInput = seen.find((input) => input.type === "multimodal" && input.parts.some((part) => part.type === "image"));
      const imagePart = imageInput?.type === "multimodal" ? imageInput.parts.find((part) => part.type === "image") : undefined;
      expect(imagePart?.type).toBe("image");
      if (imagePart?.type === "image") expect(Buffer.from(imagePart.data)).toEqual(photo);

      const post = await store.getPost(9001, 2);
      const mediaMap = await presentPostMedia([post!], store, storage);
      expect(mediaMap.get("9001:2")).toMatchObject({
        url: expect.stringMatching(/^https:\/\/objects\.example\.test\/sha256\//),
        mime_type: "image/png",
        storage_status: "stored",
      });
      expect(mediaMap.get("9001:2")).not.toHaveProperty("transcript");
      expect(mediaMap.get("9001:2")).not.toHaveProperty("description");

      const [legacy] = await db.query<{ mediaText: string | null; mediaAnalysis: unknown }>(
        `SELECT media_text AS "mediaText", media_analysis AS "mediaAnalysis" FROM posts WHERE channel_id = 9001 AND message_id = 1`,
      );
      expect(legacy?.mediaText).toBeNull();
      expect(legacy?.mediaAnalysis).toBeNull();
    } finally {
      await db.close();
    }
  }, 30_000);

  it("keeps an uploaded original after embedding failure and retries from S3 without redownloading", async () => {
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9002, ref: "@retry", username: "retry", title: "Повтор", about: null, accessHash: "1" });
      await store.upsertPosts([
        normalizeMessage(9002, message(1, "Подпись голосового", { media: mediaFor("voice", 1, "audio/ogg", 2.4, "voice.ogg") })),
      ]);
      const { storage, objects } = makeStorage();
      const base = fakeEmbedder();
      let downloads = 0;
      const options = indexerOptions(storage, async () => { downloads += 1; return voice; });
      const failing: Embedder = {
        model: base.model,
        dimensions: base.dimensions,
        modalities: base.modalities,
        async embed(inputs) {
          if (inputs.some((input) => input.type === "multimodal")) throw new Error("503 embedding unavailable");
          return base.embed(inputs);
        },
      };
      await new Indexer(store, failing, options).runOnce();
      const saved = await store.getMediaAsset(9002, 1);
      expect(saved).toMatchObject({ storageStatus: "stored", embeddingStatus: "failed" });
      expect(objects.get(saved!.objectKey!)?.bytes).toEqual(voice);
      expect(downloads).toBe(1);

      await store.retryEmbedErrors();
      await new Indexer(store, base, options).runOnce();
      expect((await store.getMediaAsset(9002, 1))?.embeddingStatus).toBe("done");
      expect(downloads).toBe(1);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("archives media the model cannot embed, skips only its vector and still indexes the post text", async () => {
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9004, ref: "@modal", username: "modal", title: "Модальности", about: null, accessHash: "1" });
      await store.upsertPosts([
        normalizeMessage(9004, message(1, "Фото кота", { media: mediaFor("photo", 2, "image/png", 0, "photo.png") })),
        normalizeMessage(9004, message(2, "Голос про борщ", { media: mediaFor("voice", 1, "audio/ogg", 2.4, "voice.ogg") })),
        normalizeMessage(9004, message(3, "Видео про хлеб", { media: mediaFor("video", 3, "video/mp4", 2.5, "video.mp4") })),
        normalizeMessage(9004, message(4, "Анимация про чай", { media: mediaFor("gif", 5, "image/gif", 1.8, "animated.gif") })),
      ]);
      const { storage, objects } = makeStorage();
      const seen: EmbeddingInput[] = [];
      const base = fakeEmbedder(["image", "audio"]);
      const embedder: Embedder = {
        model: base.model,
        dimensions: base.dimensions,
        modalities: base.modalities,
        async embed(inputs) {
          seen.push(...inputs);
          return base.embed(inputs);
        },
      };
      const byMessage: Record<number, number> = { 1: 2, 2: 1, 3: 3, 4: 5 };
      const indexer = new Indexer(store, embedder, indexerOptions(storage, async (id) => files[byMessage[id]!]!));

      expect(await indexer.runOnce()).toBe(4);
      expect(await store.indexStats()).toMatchObject({ posts: 4, indexed: 4, pending: 0, failed: 0 });

      for (const messageId of [1, 2]) {
        expect(await store.getMediaAsset(9004, messageId)).toMatchObject({ storageStatus: "stored", embeddingStatus: "done" });
      }
      for (const [messageId, original] of [[3, video], [4, gif]] as const) {
        const asset = await store.getMediaAsset(9004, messageId);
        expect(asset).toMatchObject({ storageStatus: "stored", embeddingStatus: "skipped" });
        expect(asset?.embeddingError).toMatch(/не принимает video/);
        expect(objects.get(asset!.objectKey!)?.bytes).toEqual(original);
      }

      const rows = await db.query<{ messageId: number; kind: string }>(
        `SELECT message_id AS "messageId", kind FROM chunks ORDER BY message_id, chunk_index`,
      );
      expect(rows.filter((row) => row.kind === "video")).toEqual([]);
      for (const messageId of [1, 2, 3, 4]) {
        expect(rows.some((row) => row.messageId === messageId && row.kind === "text")).toBe(true);
      }
      expect(seen.some((input) => input.type === "multimodal" && input.parts.some((part) => part.type === "video"))).toBe(false);

      const post = await store.getPost(9004, 3);
      const mediaMap = await presentPostMedia([post!], store, storage);
      expect(mediaMap.get("9004:3")).toMatchObject({
        url: expect.stringMatching(/^https:\/\/objects\.example\.test\/sha256\//),
        storage_status: "stored",
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("archives media above the processing duration limit and reports an explicit embedding skip", async () => {
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9003, ref: "@limited", username: "limited", title: "Лимит", about: null, accessHash: "1" });
      await store.upsertPosts([
        normalizeMessage(9003, message(1, "Длинный ролик", { media: mediaFor("video", 3, "video/mp4", 2.5, "video.mp4") })),
      ]);
      const { storage, objects } = makeStorage();
      const embedder = fakeEmbedder();
      const indexer = new Indexer(
        store,
        embedder,
        indexerOptions(storage, async () => video, { maxEmbedSeconds: 1 }),
      );

      await indexer.runOnce();
      const asset = await store.getMediaAsset(9003, 1);
      expect(asset).toMatchObject({ storageStatus: "stored", embeddingStatus: "skipped" });
      expect(objects.get(asset!.objectKey!)?.bytes).toEqual(video);
      expect(await store.indexStats()).toMatchObject({ indexed: 1, pending: 0 });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("keeps the post text indexed when its attachment cannot be downloaded, and retries only the attachment", async () => {
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9005, ref: "@flood", username: "flood", title: "Флуд", about: null, accessHash: "1" });
      await store.upsertPosts([
        normalizeMessage(9005, message(1, "Подпись к фото кота", { media: mediaFor("photo", 2, "image/png", 0, "photo.png") })),
      ]);
      const { storage } = makeStorage();
      let failing = true;
      const options = indexerOptions(storage, async () => {
        if (failing) throw new Error("FLOOD_WAIT_30");
        return photo;
      });
      const embedder = fakeEmbedder();

      await new Indexer(store, embedder, options).runOnce();

      const [row] = await db.query<{ embedError: string | null; embeddedHash: string | null; indexHash: string }>(
        `SELECT embed_error AS "embedError", embedded_hash AS "embeddedHash", index_hash AS "indexHash"
         FROM posts WHERE channel_id = 9005`,
      );
      expect(row?.embedError).toBeNull();
      expect(row?.embeddedHash).toBe(row?.indexHash);
      expect(await db.query("SELECT kind FROM chunks WHERE channel_id = 9005")).toEqual([{ kind: "text" }]);
      const failed = await store.getMediaAsset(9005, 1);
      expect(failed).toMatchObject({ storageStatus: "failed" });
      expect(failed?.storageError).toMatch(/FLOOD_WAIT_30/);
      expect(await store.indexStats(options.mediaTypes)).toMatchObject({ failed: 1 });

      failing = false;
      await store.retryEmbedErrors();
      await new Indexer(store, embedder, options).runOnce();
      expect(await store.getMediaAsset(9005, 1)).toMatchObject({ storageStatus: "stored", embeddingStatus: "done" });
      const kinds = await db.query<{ kind: string }>("SELECT kind FROM chunks WHERE channel_id = 9005 ORDER BY chunk_index");
      expect(kinds.map((chunk) => chunk.kind)).toEqual(["text", "image"]);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("skips a file whose size reported by Telegram exceeds the limit without downloading it", async () => {
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9006, ref: "@huge", username: "huge", title: "Тяжёлый", about: null, accessHash: "1" });
      await store.upsertPosts([
        normalizeMessage(9006, message(1, "Огромный ролик", { media: mediaFor("video", 3, "video/mp4", 2.5, "video.mp4") })),
      ]);
      const { storage } = makeStorage();
      let downloads = 0;
      const options = indexerOptions(storage, async () => { downloads += 1; return video; }, { maxEmbedBytes: 1024 });

      await new Indexer(store, fakeEmbedder(), options).runOnce();

      expect(downloads).toBe(0);
      const asset = await store.getMediaAsset(9006, 1);
      expect(asset).toMatchObject({ storageStatus: "skipped", embeddingStatus: "skipped" });
      expect(asset?.storageError).toMatch(/фоновой индексации/);
      expect(await store.indexStats(options.mediaTypes)).toMatchObject({ indexed: 1, pending: 0, failed: 0 });
      expect(await db.query("SELECT kind FROM chunks WHERE channel_id = 9006")).toEqual([{ kind: "text" }]);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("archives a pending original on a direct request and returns its link", async () => {
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9012, ref: "@direct", username: "direct", title: "Прямой запрос", about: null, accessHash: "1" });
      await store.upsertPosts([
        normalizeMessage(9012, message(1, "Фото по ссылке", { media: mediaFor("photo", 2, "image/png", 0, "photo.png") })),
      ]);
      const { storage } = makeStorage();
      const indexer = new Indexer(store, fakeEmbedder(), indexerOptions(storage, async () => photo));
      const post = (await store.getPost(9012, 1))!;

      await indexer.ensureOriginal(post);

      expect(await store.getMediaAsset(9012, 1)).toMatchObject({
        storageStatus: "stored",
        embeddingStatus: "pending",
      });
      const media = await presentPostMedia([post], store, storage);
      expect(media.get("9012:1")).toMatchObject({
        url: expect.stringMatching(/^https:\/\/objects\.example\.test\/sha256\//),
        storage_status: "stored",
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("keeps a direct original above the vector limit out of search but available by link", async () => {
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9013, ref: "@large", username: "large", title: "Большой", about: null, accessHash: "1" });
      await store.upsertPosts([
        normalizeMessage(9013, message(1, "Фото больше лимита вектора", { media: mediaFor("photo", 2, "image/png", 0, "photo.png") })),
      ]);
      const { storage } = makeStorage();
      const indexer = new Indexer(
        store,
        fakeEmbedder(),
        indexerOptions(storage, async () => photo, { maxEmbedBytes: 1 }),
      );
      const post = (await store.getPost(9013, 1))!;

      await indexer.ensureOriginal(post);

      const asset = await store.getMediaAsset(9013, 1);
      expect(asset).toMatchObject({ storageStatus: "stored", embeddingStatus: "skipped" });
      expect(asset?.embeddingError).toMatch(/векторного поиска/);
      expect(await db.query("SELECT kind FROM chunks WHERE channel_id = 9013")).toEqual([]);
      const media = await presentPostMedia([post], store, storage);
      expect(media.get("9013:1")).toMatchObject({
        url: expect.stringMatching(/^https:\/\/objects\.example\.test\/sha256\//),
        storage_status: "stored",
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("streams the original through a temporary file when Telegram writes to disk", async () => {
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9014, ref: "@stream", username: "stream", title: "Поток", about: null, accessHash: "1" });
      await store.upsertPosts([
        normalizeMessage(9014, message(1, "Фото потоком", { media: mediaFor("photo", 2, "image/png", 0, "photo.png") })),
      ]);
      const { storage, objects } = makeStorage();
      const options = {
        ...indexerOptions(storage, async () => photo),
        maxEmbedBytes: 1,
        downloadMedia: undefined,
        downloadMediaToFile: async (_channelId: number, _messageId: number, _expected: PostMedia, path: string) => {
          await writeFile(path, photo);
        },
      };
      const indexer = new Indexer(store, fakeEmbedder(), options);

      await indexer.ensureOriginal((await store.getPost(9014, 1))!);

      const asset = await store.getMediaAsset(9014, 1);
      expect(asset).toMatchObject({ storageStatus: "stored", embeddingStatus: "skipped" });
      expect(asset?.embeddingError).toMatch(/векторного поиска/);
      expect(objects.get(asset!.objectKey!)?.bytes).toEqual(photo);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("does not let a late parallel failure overwrite a stored original", async () => {
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9015, ref: "@race", username: "race", title: "Гонка", about: null, accessHash: "1" });
      await store.upsertPosts([
        normalizeMessage(9015, message(1, "Фото при гонке", { media: mediaFor("photo", 2, "image/png", 0, "photo.png") })),
      ]);
      const { storage } = makeStorage();
      await new Indexer(store, fakeEmbedder(), indexerOptions(storage, async () => photo)).runOnce();
      const post = (await store.getPost(9015, 1))!;
      const reference = {
        channelId: 9015,
        messageId: 1,
        sourceFileId: post.media?.fileId,
        sourceFingerprint: mediaSourceFingerprint(post.media),
      };

      await store.markMediaStorageFailed(reference, "late download failure");
      expect(await store.getMediaAsset(9015, 1)).toMatchObject({ storageStatus: "stored" });

      await store.markMediaStorageSkipped(reference, "late skip");
      expect(await store.getMediaAsset(9015, 1)).toMatchObject({ storageStatus: "stored" });

      await store.markMediaStorageFailed(reference, "stored object is unreadable", { allowStored: true });
      expect(await store.getMediaAsset(9015, 1)).toMatchObject({ storageStatus: "failed" });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("drops the vectors of a partially prepared attachment and keeps the skip reason", async () => {
    const actual = await vi.importActual<typeof import("../src/media/prepare.ts")>("../src/media/prepare.ts");
    prepareHook.override = async function* (...args: Parameters<typeof actual.prepareMediaChunks>) {
      yield (await actual.prepareMediaChunks(...args).next()).value;
      throw new Error("ffmpeg timed out");
    };
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9007, ref: "@partial", username: "partial", title: "Частично", about: null, accessHash: "1" });
      await store.upsertPosts([
        normalizeMessage(9007, message(1, "Ролик, упавший на втором сегменте", { media: mediaFor("video", 3, "video/mp4", 2.5, "video.mp4") })),
      ]);
      const { storage } = makeStorage();
      const options = indexerOptions(storage, async () => video);

      await new Indexer(store, fakeEmbedder(), options).runOnce();

      const asset = await store.getMediaAsset(9007, 1);
      expect(asset).toMatchObject({ storageStatus: "stored", embeddingStatus: "skipped" });
      expect(asset?.embeddingError).toMatch(/ffmpeg timed out/);
      expect(await db.query("SELECT kind FROM chunks WHERE channel_id = 9007")).toEqual([{ kind: "text" }]);
      expect(await store.indexStats(options.mediaTypes)).toMatchObject({ indexed: 1, pending: 0 });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("stops between segments, writes nothing and leaves the post in the queue", async () => {
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9008, ref: "@halt", username: "halt", title: "Остановка", about: null, accessHash: "1" });
      await store.upsertPosts([
        normalizeMessage(9008, message(1, "Видео, которое не успели доиндексировать", { media: mediaFor("video", 3, "video/mp4", 2.5, "video.mp4") })),
      ]);
      const { storage } = makeStorage();
      const base = fakeEmbedder();
      let multimodalCalls = 0;
      let indexer!: Indexer;
      const embedder: Embedder = {
        model: base.model,
        dimensions: base.dimensions,
        modalities: base.modalities,
        async embed(inputs) {
          if (inputs.some((input) => input.type === "multimodal")) {
            multimodalCalls += 1;
            void indexer.stop();
          }
          return base.embed(inputs);
        },
      };
      const options = indexerOptions(storage, async () => video);
      indexer = new Indexer(store, embedder, options);

      await indexer.runOnce();

      expect(multimodalCalls).toBe(1);
      expect(await db.query("SELECT 1 FROM chunks WHERE channel_id = 9008")).toHaveLength(0);
      expect(await store.pendingForEmbedding(10, options.mediaTypes)).toHaveLength(1);
      expect(await store.getMediaAsset(9008, 1)).toMatchObject({ storageStatus: "stored", embeddingStatus: "pending" });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("keeps measured file metadata when a stored attachment is re-indexed after a caption edit", async () => {
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9009, ref: "@edit", username: "edit", title: "Правка", about: null, accessHash: "1" });
      const media = mediaFor("photo", 2, "image/png", 0, "photo.png");
      await store.upsertPosts([normalizeMessage(9009, message(1, "Первая подпись", { media }))]);
      const { storage } = makeStorage();
      let downloads = 0;
      const options = indexerOptions(storage, async () => { downloads += 1; return photo; });
      const embedder = fakeEmbedder();
      await new Indexer(store, embedder, options).runOnce();
      const stored = await store.getMediaAsset(9009, 1);
      expect(stored).toMatchObject({ mimeType: "image/png", storageStatus: "stored" });
      expect(stored?.size).toBe(photo.byteLength);

      await store.upsertPosts([normalizeMessage(9009, message(1, "Подпись после правки", { media }))]);
      expect(await store.pendingForEmbedding(10, options.mediaTypes)).toHaveLength(1);
      await new Indexer(store, embedder, options).runOnce();

      expect(downloads).toBe(1);
      expect(await store.getMediaAsset(9009, 1)).toMatchObject({
        mimeType: stored!.mimeType,
        fileName: stored!.fileName,
        size: stored!.size,
        embeddingStatus: "done",
      });
      const mediaMap = await presentPostMedia([(await store.getPost(9009, 1))!], store, storage);
      expect(mediaMap.get("9009:1")).toMatchObject({ mime_type: "image/png" });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("removes the vectors of a replaced attachment even when the post cannot be re-indexed yet", async () => {
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9011, ref: "@swap", username: "swap", title: "Замена", about: null, accessHash: "1" });
      await store.upsertPosts([
        normalizeMessage(9011, message(1, "Фото, которое заменят", { media: mediaFor("photo", 2, "image/png", 0, "photo.png") })),
      ]);
      const { storage } = makeStorage();
      const options = indexerOptions(storage, async () => photo);
      const healthy = fakeEmbedder();
      await new Indexer(store, healthy, options).runOnce();
      const kindsOf = async () =>
        (await db.query<{ kind: string }>("SELECT kind FROM chunks WHERE channel_id = 9011 ORDER BY chunk_index")).map((chunk) => chunk.kind);
      expect(await kindsOf()).toEqual(["text", "image"]);

      // Вложение подменили другим файлом, а сервис эмбеддингов недоступен.
      await store.upsertPosts([
        normalizeMessage(9011, message(1, "Фото, которое заменят", { media: mediaFor("photo", 7, "image/png", 0, "other.png") })),
      ]);
      const down: Embedder = {
        model: healthy.model,
        dimensions: healthy.dimensions,
        modalities: healthy.modalities,
        async embed() {
          throw new Error("embedding service down");
        },
      };
      await new Indexer(store, down, options).runOnce();

      expect(await kindsOf()).toEqual(["text"]);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("rebuilds media vectors from S3 when Telegram is not connected", async () => {
    const { db, store } = await freshStore();
    try {
      await store.upsertChannel({ id: 9010, ref: "@offline", username: "offline", title: "Без Telegram", about: null, accessHash: "1" });
      await store.upsertPosts([
        normalizeMessage(9010, message(1, "Фото при переиндексации", { media: mediaFor("photo", 2, "image/png", 0, "photo.png") })),
      ]);
      const { storage } = makeStorage();
      let downloads = 0;
      const options = indexerOptions(storage, async () => { downloads += 1; return photo; });
      const embedder = fakeEmbedder();
      await new Indexer(store, embedder, options).runOnce();

      // Как после смены модели: векторы нужно построить заново.
      await db.query("UPDATE posts SET embedded_hash = NULL WHERE channel_id = 9010");
      const { downloadMedia: _telegram, ...withoutTelegram } = options;
      await new Indexer(store, embedder, withoutTelegram).runOnce();

      const kinds = await db.query<{ kind: string }>("SELECT kind FROM chunks WHERE channel_id = 9010 ORDER BY chunk_index");
      expect(kinds.map((chunk) => chunk.kind)).toEqual(["text", "image"]);
      expect(downloads).toBe(1);
    } finally {
      await db.close();
    }
  }, 30_000);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
