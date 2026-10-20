/**
 * Все типы вложений: разбор, архив, показ в ленте и исключение из поиска.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { Indexer } from "../src/indexer.ts";
import { MEDIA_TYPES } from "../src/media/prepare.ts";
import type { ObjectStorage, SaveOriginalInput, StoredOriginal } from "../src/storage.ts";
import { normalizeMessage } from "../src/telegram/normalize.ts";
import { callTool, type ToolContext } from "../src/tools.ts";
import { fakeEmbedder, freshStore, message } from "./helpers.ts";

const CHANNEL_ID = 9500;

function makeStorage() {
  const objects = new Map<string, Buffer>();
  const storage: ObjectStorage = {
    bucket: "test-media",
    async saveOriginal(input: SaveOriginalInput): Promise<StoredOriginal> {
      const sha256 = createHash("sha256").update(input.bytes).digest("hex");
      const key = `sha256/${sha256}`;
      objects.set(key, Buffer.from(input.bytes));
      return { key, sha256, size: input.bytes.byteLength, contentType: input.contentType };
    },
    async saveOriginalFile(input) {
      const bytes = await readFile(input.path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const key = `sha256/${sha256}`;
      objects.set(key, bytes);
      return { key, sha256, size: bytes.byteLength, contentType: input.contentType };
    },
    async readOriginal(key) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("missing object");
      return bytes;
    },
    async signGet(key) {
      return {
        url: `https://objects.example.test/${key}?signed=1`,
        expiresIn: 60,
        expiresAt: new Date(Date.now() + 60_000),
      };
    },
    async close() {},
  };
  return { storage, objects };
}

const sticker = {
  className: "MessageMediaDocument",
  document: {
    id: { toString: () => "7001" },
    mimeType: "image/webp",
    size: 100,
    attributes: [{ className: "DocumentAttributeSticker", alt: "😺", stickerset: { shortName: "Cats" } }],
  },
};

const document = {
  className: "MessageMediaDocument",
  document: {
    id: { toString: () => "7002" },
    mimeType: "application/pdf",
    size: 12,
    attributes: [{ className: "DocumentAttributeFilename", fileName: "report.pdf" }],
  },
};

const giveaway = {
  className: "MessageMediaGiveaway",
  quantity: 3,
  months: 1,
  stars: 100,
  untilDate: 1000,
  prizeDescription: "Подписка",
  channels: [{ toString: () => "5" }],
};

const contact = {
  className: "MessageMediaContact",
  phoneNumber: "+7 999 123-45-67",
  firstName: "Иван",
  lastName: "Петров",
  userId: { toString: () => "42" },
};

const paid = {
  className: "MessageMediaPaidMedia",
  starsAmount: 50,
  extendedMedia: [{ className: "MessageExtendedMediaPreview", w: 640, h: 480, videoDuration: 5 }],
};

const { db, store } = await freshStore();
const embedder = fakeEmbedder();
const { storage, objects } = makeStorage();
afterAll(() => db.close());

const context: ToolContext = { store, embedder, storage };

describe("типы сообщений", () => {
  it("архивирует документы и стикеры, но не строит для них векторы", async () => {
    await store.upsertChannel({
      id: CHANNEL_ID,
      ref: "@types",
      username: "types",
      title: "Все типы",
      about: null,
      accessHash: "1",
    });
    await store.upsertPosts([
      normalizeMessage(CHANNEL_ID, message(1, "Стикер с котом", { media: sticker })),
      normalizeMessage(CHANNEL_ID, message(2, "Документ отчёта", { media: document })),
      normalizeMessage(CHANNEL_ID, message(3, "Розыгрыш подписки", { media: giveaway })),
      normalizeMessage(CHANNEL_ID, message(4, "Контакт автора", { media: contact })),
      normalizeMessage(CHANNEL_ID, message(5, "Обычный текст")),
      normalizeMessage(CHANNEL_ID, message(6, "Платный пост", { media: paid })),
    ]);

    const indexer = new Indexer(store, embedder, {
      batchSize: 64,
      concurrency: 1,
      mediaTypes: [...MEDIA_TYPES],
      maxArchiveBytes: 20 * 1_048_576,
      maxEmbedBytes: 20 * 1_048_576,
      maxEmbedSeconds: 1800,
      segmentSeconds: 60,
      segmentOverlapSeconds: 5,
      storage,
      downloadMedia: async (_channelId, messageId) =>
        Buffer.from(messageId === 1 ? "sticker-bytes" : "%PDF-1.4 report"),
    });

    while ((await indexer.runOnce()) > 0);

    expect(await store.getMediaAsset(CHANNEL_ID, 1)).toMatchObject({
      storageStatus: "stored",
      embeddingStatus: "skipped",
    });
    expect(await store.getMediaAsset(CHANNEL_ID, 2)).toMatchObject({
      storageStatus: "stored",
      embeddingStatus: "skipped",
    });
    expect(objects.size).toBe(2);

    const chunks = await db.query<{ messageId: number }>(
      "SELECT message_id AS \"messageId\" FROM chunks WHERE channel_id = $1 ORDER BY message_id",
      [CHANNEL_ID],
    );
    expect([...new Set(chunks.map((chunk) => chunk.messageId))]).toEqual([2, 4, 5]);

    expect(await store.indexStats([...MEDIA_TYPES])).toMatchObject({
      posts: 6,
      indexed: 6,
      pending: 0,
      failed: 0,
    });
  });

  it("показывает все типы в ленте и не отдаёт служебные повторы канала", async () => {
    const list = (await callTool("list_posts", { channel: "@types", limit: 20 }, context)) as any;
    expect(list.posts).toHaveLength(6);
    const byId = new Map<number, any>(list.posts.map((post: any) => [post.message_id, post]));

    expect(byId.get(1).channel).toBeUndefined();
    expect(byId.get(1).media).toMatchObject({
      type: "sticker",
      sticker: { alt: "😺", setName: "Cats" },
      storage_status: "stored",
      url: expect.stringMatching(/^https:\/\/objects\.example\.test\//),
    });
    expect(byId.get(2).media).toMatchObject({
      type: "document",
      file_name: "report.pdf",
      mime_type: "application/pdf",
      storage_status: "stored",
      url: expect.stringMatching(/^https:\/\/objects\.example\.test\//),
    });
    expect(byId.get(3).media).toMatchObject({
      type: "giveaway",
      giveaway: { quantity: 3, prizeDescription: "Подписка", channels: ["5"] },
    });
    expect(byId.get(4).media).toMatchObject({
      type: "contact",
      contact: { firstName: "Иван", lastName: "Петров", phoneNumber: "+7 999 123-45-67" },
    });
    expect(byId.get(6).media).toMatchObject({
      type: "paid_media",
      paidMedia: { starsAmount: 50, items: [{ preview: true, width: 640, height: 480, duration: 5 }] },
    });
  });

  it("фильтрует ленту по типу вложения, в том числе по слову documents", async () => {
    const documents = (await callTool(
      "list_posts",
      { channel: "@types", media_types: "documents" },
      context,
    )) as any;
    expect(documents.posts.map((post: any) => post.message_id)).toEqual([2]);

    const stickers = (await callTool(
      "list_posts",
      { channel: "@types", media_types: ["stickers", "giveaway"] },
      context,
    )) as any;
    expect(stickers.posts.map((post: any) => post.message_id).sort()).toEqual([1, 3]);
  });

  it("не ищет стикеры, раздачи и платные посты, но ищет остальные", async () => {
    const stickerHit = (await callTool("search_posts", { query: "Стикер с котом" }, context)) as any;
    expect(stickerHit.results.every((post: any) => post.message_id !== 1)).toBe(true);

    const giveawayHit = (await callTool("search_posts", { query: "Розыгрыш подписки" }, context)) as any;
    expect(giveawayHit.results.every((post: any) => post.message_id !== 3)).toBe(true);

    const paidHit = (await callTool("search_posts", { query: "Платный пост" }, context)) as any;
    expect(paidHit.results.every((post: any) => post.message_id !== 6)).toBe(true);

    const documentHit = (await callTool("search_posts", { query: "Документ отчёта" }, context)) as any;
    expect(documentHit.results.some((post: any) => post.message_id === 2)).toBe(true);

    const textHit = (await callTool("search_posts", { query: "Обычный текст" }, context)) as any;
    expect(textHit.results.some((post: any) => post.message_id === 5)).toBe(true);
  });
});
