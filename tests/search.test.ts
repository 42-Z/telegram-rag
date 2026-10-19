import { describe, expect, it } from "vitest";
import { Indexer } from "../src/indexer.ts";
import { normalizeMessage } from "../src/telegram/normalize.ts";
import { fakeEmbedder, freshStore, message } from "./helpers.ts";

describe("semantic search after an edit", () => {
  it("keeps finding an edited post by its earlier vectors until it is re-indexed", async () => {
    const { db, store } = await freshStore();
    try {
      const channel = await store.upsertChannel({ id: 9100, ref: "@edit", username: "edit", title: "Правки", about: null, accessHash: "1" });
      await store.upsertPosts([normalizeMessage(channel.id, message(1, "Рецепт борща со свёклой и капустой"))]);
      const embedder = fakeEmbedder();
      await new Indexer(store, embedder, {
        batchSize: 10,
        concurrency: 1,
        mediaTypes: [],
        maxArchiveBytes: 1,
        maxEmbedBytes: 1,
        maxEmbedSeconds: 1,
        segmentSeconds: 1,
        segmentOverlapSeconds: 0,
      }).runOnce();
      const [query] = await embedder.embed([{ type: "text", purpose: "query", text: "борщ со свёклой" }]);
      const found = async () => (await store.semanticSearch(query!, {}, 5)).map((hit) => hit.post.messageId);
      expect(await found()).toEqual([1]);

      await store.upsertPosts([normalizeMessage(channel.id, message(1, "Совсем другой текст про хлеб"))]);
      expect(await store.pendingForEmbedding(10)).toHaveLength(1);
      expect(await found()).toEqual([1]);

      // Сбой переиндексации не прячет пост, пока не построены новые векторы.
      await store.markEmbedErrorIfCurrent(
        { channelId: channel.id, messageId: 1, indexHash: (await store.pendingForEmbedding(10))[0]!.indexHash },
        "embedding service unavailable",
      );
      expect(await db.query("SELECT 1 FROM posts WHERE embed_error IS NOT NULL")).toHaveLength(1);
      expect(await found()).toEqual([1]);
    } finally {
      await db.close();
    }
  }, 30_000);
});
