import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Embedder, EmbeddingInput } from "../src/embeddings.ts";
import { Indexer, type IndexerOptions } from "../src/indexer.ts";
import { presentPostMedia } from "../src/presentation.ts";
import type { ObjectStorage, SaveOriginalInput, StoredOriginal } from "../src/storage.ts";
import { normalizeMessage, type PostMedia } from "../src/telegram/normalize.ts";
import { fakeEmbedder, freshStore, message } from "./helpers.ts";

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
    maxMediaBytes: 20 * 1_048_576,
    maxMediaSeconds: 1800,
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
        indexerOptions(storage, async () => video, { maxMediaSeconds: 1 }),
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
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
