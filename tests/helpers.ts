import { createHash } from "node:crypto";
import { migrate, openDb, type Db } from "../src/db.ts";
import type { Embedder } from "../src/embeddings.ts";
import { Store } from "../src/store.ts";
import { normalizeMessage, type MessageLike } from "../src/telegram/normalize.ts";

export const DIMENSIONS = 64;

/**
 * Предсказуемые «эмбеддинги» без сети: мешок слов, свёрнутый в вектор.
 * Тексты с общими словами оказываются рядом — этого хватает, чтобы проверить
 * путь поиска по смыслу целиком, от запроса до ответа.
 */
export function fakeEmbedder(): Embedder & { calls: number } {
  const embedder = {
    model: "fake",
    dimensions: DIMENSIONS,
    calls: 0,
    async embed(texts: readonly string[]) {
      embedder.calls += 1;
      return texts.map((text) => {
        const vector = new Array<number>(DIMENSIONS).fill(0);
        for (const word of text.toLowerCase().match(/[\p{L}\d]{3,}/gu) ?? []) {
          const stem = word.slice(0, 5);
          const bucket = createHash("md5").update(stem).digest().readUInt32LE(0) % DIMENSIONS;
          vector[bucket]! += 1;
        }
        const norm = Math.hypot(...vector) || 1;
        return vector.map((value) => value / norm);
      });
    },
  };
  return embedder;
}

export async function freshStore(): Promise<{ db: Db; store: Store }> {
  const db = await openDb("memory://");
  await migrate(db, { model: "fake", dimensions: DIMENSIONS });
  return { db, store: new Store(db) };
}

export function message(id: number, text: string, extra: Partial<MessageLike> = {}): MessageLike {
  return {
    className: "Message",
    id,
    date: Math.floor(Date.UTC(2026, 8, 1, 12) / 1000) + id * 3600,
    message: text,
    views: 100 + id,
    ...extra,
  };
}

export async function seed(store: Store) {
  const tech = await store.upsertChannel({
    id: 1001,
    ref: "@tech",
    username: "tech",
    title: "Tech News",
    about: "Новости технологий",
    accessHash: "1",
  });
  const food = await store.upsertChannel({
    id: 1002,
    ref: "@food",
    username: "food",
    title: "Кулинария",
    about: null,
    accessHash: "2",
  });
  await store.upsertPosts([
    normalizeMessage(tech.id, message(1, "Вышла новая видеокарта с огромной производительностью в играх")),
    normalizeMessage(tech.id, message(2, "Обзор смартфона: камера, батарея и экран")),
    normalizeMessage(tech.id, message(3, "", { media: { className: "MessageMediaPhoto" }, groupedId: { toString: () => "77" } })),
    normalizeMessage(tech.id, message(4, "Фото с презентации процессоров", { media: { className: "MessageMediaPhoto" }, groupedId: { toString: () => "77" } })),
    normalizeMessage(food.id, message(1, "Рецепт борща: свёкла, капуста, картофель и говядина")),
    normalizeMessage(food.id, message(2, "Как испечь хлеб на закваске дома")),
  ]);
  return { tech, food };
}
