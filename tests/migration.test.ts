import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDb, type Db } from "../src/db.ts";
import { normalizeMessage } from "../src/telegram/normalize.ts";
import { Store } from "../src/store.ts";
import { DIMENSIONS, message } from "./helpers.ts";

let db: Db | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function setup() {
  db = await openDb("memory://");
  await migrate(db, { model: "fake", dimensions: DIMENSIONS });
  const store = new Store(db);
  const channel = await store.upsertChannel({
    id: 7001,
    ref: "@migration",
    username: "migration",
    title: "Проверка миграции",
    about: null,
    accessHash: "1",
  });
  const post = normalizeMessage(
    channel.id,
    message(1, "Исходная фраза остаётся в посте", {
      media: {
        className: "MessageMediaDocument",
        document: {
          id: { toString: () => "telegram-file-1" },
          mimeType: "audio/ogg",
          size: 100,
          attributes: [{ className: "DocumentAttributeAudio", voice: true, duration: 2 }],
        },
      },
    }),
  );
  await store.upsertPosts([post]);
  return { store, post };
}

describe("source-only index migration", () => {
  it("removes legacy generated media text from full-text and vector search once", async () => {
    const { store, post } = await setup();
    const vectors = Array.from({ length: DIMENSIONS }, () => 0.1);
    const [pending] = await store.pendingForEmbedding(1);
    expect(pending).toBeDefined();
    expect(
      await store.replaceChunks(
        { channelId: post.channelId, messageId: post.messageId, indexHash: pending!.indexHash },
        [{ content: "Старая расшифровка уникальныйзапрос", embedding: vectors }],
      ),
    ).toBe(true);
    await db!.query(
      "UPDATE posts SET media_text = $3, embedded_hash = index_hash WHERE channel_id = $1 AND message_id = $2",
      [post.channelId, post.messageId, "Старая расшифровка уникальныйзапрос"],
    );

    // Вернуть именно старые generated expressions и старый формат chunks.
    await db!.exec(`
      DROP INDEX posts_tsv;
      DROP INDEX posts_pending;
      ALTER TABLE posts DROP COLUMN tsv;
      ALTER TABLE posts ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('russian', text || ' ' || coalesce(media->>'searchText', '') || ' ' || coalesce(media_text, ''))
      ) STORED;
      ALTER TABLE posts DROP COLUMN index_hash;
      ALTER TABLE posts ADD COLUMN index_hash text GENERATED ALWAYS AS (
        content_hash || coalesce(md5(media_text), '')
      ) STORED;
      DROP TABLE chunks;
      CREATE TABLE chunks (
        channel_id bigint NOT NULL,
        message_id integer NOT NULL,
        chunk_index integer NOT NULL,
        content text NOT NULL,
        embedding vector(${DIMENSIONS}) NOT NULL,
        PRIMARY KEY (channel_id, message_id, chunk_index),
        FOREIGN KEY (channel_id, message_id) REFERENCES posts (channel_id, message_id) ON DELETE CASCADE
      );
    `);
    await db!.query("DELETE FROM meta WHERE key = 'source_index_schema'");

    await migrate(db!, { model: "fake", dimensions: DIMENSIONS });

    expect(await store.keywordSearch("уникальныйзапрос", {}, 10)).toHaveLength(0);
    expect(await store.keywordSearch("исходная фраза", {}, 10)).toHaveLength(1);
    expect(await store.pendingForEmbedding(10)).toHaveLength(1);
    expect(await db!.query("SELECT * FROM chunks")).toHaveLength(0);
    const [version] = await db!.query<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'source_index_schema'",
    );
    expect(version?.value).toBe("3");

    const [assetTable] = await db!.query<{ exists: boolean }>(
      "SELECT to_regclass('public.media_assets') IS NOT NULL AS exists",
    );
    expect(assetTable?.exists).toBe(true);
  }, 30_000);

  it("does not reset vectors on an idempotent migration, but does on profile change", async () => {
    const { store, post } = await setup();
    const vectors = Array.from({ length: DIMENSIONS }, () => 0.25);
    const source = await store.pendingForEmbedding(1);
    expect(source).toHaveLength(1);
    expect(
      await store.replaceChunks(
        { channelId: post.channelId, messageId: post.messageId, indexHash: source[0]!.indexHash },
        [{ content: "исходный вектор", embedding: vectors }],
      ),
    ).toBe(true);

    await migrate(db!, { model: "fake", dimensions: DIMENSIONS });
    expect(await db!.query("SELECT * FROM chunks")).toHaveLength(1);
    expect(await store.pendingForEmbedding(10)).toHaveLength(0);

    await migrate(db!, { model: "fake", dimensions: DIMENSIONS, profile: "changed-preparation" });
    expect(await db!.query("SELECT * FROM chunks")).toHaveLength(0);
    expect(await store.pendingForEmbedding(10)).toHaveLength(1);
  }, 30_000);

  it("rolls back chunk replacement when a chunk violates its kind constraint", async () => {
    const { store, post } = await setup();
    const source = await store.pendingForEmbedding(1);
    const vectors = Array.from({ length: DIMENSIONS }, () => 0.5);
    const reference = { channelId: post.channelId, messageId: post.messageId, indexHash: source[0]!.indexHash };
    expect(await store.replaceChunks(reference, [{ content: "сохранённый", embedding: vectors }])).toBe(true);

    await expect(
      store.replaceChunks(reference, [{ kind: "image", content: "not allowed", embedding: vectors }]),
    ).rejects.toThrow();

    const chunks = await db!.query<{ content: string }>(
      "SELECT content FROM chunks WHERE channel_id = $1 AND message_id = $2",
      [post.channelId, post.messageId],
    );
    expect(chunks).toEqual([{ content: "сохранённый" }]);
    expect(await store.pendingForEmbedding(10)).toHaveLength(0);
  }, 30_000);
});
