import { describe, expect, it } from "vitest";
import { buildChunks, splitText } from "../src/chunks.ts";
import { parseChannelRef } from "../src/telegram/client.ts";
import { describeMedia, isPost, normalizeMessage, postLink, tidyMarkdown } from "../src/telegram/normalize.ts";
import { collapseAlbums, fuseRankings } from "../src/tools.ts";
import type { Post } from "../src/store.ts";

describe("parseChannelRef", () => {
  it("понимает все записи канала", () => {
    expect(parseChannelRef("@durov")).toEqual({ kind: "username", value: "durov" });
    expect(parseChannelRef("https://t.me/durov")).toEqual({ kind: "username", value: "durov" });
    expect(parseChannelRef("t.me/s/durov/123")).toEqual({ kind: "username", value: "durov" });
    expect(parseChannelRef("https://t.me/+AbC_d-1")).toEqual({ kind: "invite", hash: "AbC_d-1" });
    expect(parseChannelRef("https://t.me/joinchat/XYZ")).toEqual({ kind: "invite", hash: "XYZ" });
    expect(parseChannelRef("-1001234567890")).toEqual({ kind: "id", id: 1234567890 });
    expect(() => parseChannelRef("не канал")).toThrow();
  });
});

describe("normalizeMessage", () => {
  it("берёт текст с разметкой, реакции, пересылку и считает отпечаток", () => {
    const post = normalizeMessage(5, {
      className: "Message",
      id: 10,
      date: 1_700_000_000,
      editDate: 1_700_000_100,
      message: "Смотри тут",
      text: "Смотри [тут](https://example.com)",
      views: 42,
      replies: { replies: 3 },
      reactions: { results: [{ reaction: { className: "ReactionEmoji", emoticon: "🔥" }, count: 7 }] },
      fwdFrom: { fromId: { channelId: 99 }, channelPost: 5, date: 1_690_000_000 },
    });
    expect(post.text).toBe("Смотри [тут](https://example.com)");
    expect(post.date.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(post.reactions).toEqual([{ reaction: "🔥", count: 7 }]);
    expect(post.replies).toBe(3);
    expect(post.forwardedFrom).toMatchObject({ channelId: 99, messageId: 5 });
    expect(post.contentHash).toHaveLength(32);
    // отпечаток зависит от содержимого, а не от просмотров
    expect(normalizeMessage(5, { className: "Message", id: 10, text: post.text, views: 1 }).contentHash).toBe(post.contentHash);
  });

  it("описывает медиа так, чтобы по нему можно было искать", () => {
    expect(
      describeMedia({
        className: "MessageMediaWebPage",
        webpage: { className: "WebPage", url: "https://x.y", title: "Заголовок", description: "Описание" },
      }),
    ).toMatchObject({ type: "webpage", searchText: "Заголовок\nОписание" });
    expect(
      describeMedia({
        className: "MessageMediaPoll",
        poll: { question: { text: "Кто?" }, answers: [{ text: { text: "Я" } }, { text: { text: "Ты" } }] },
      }),
    ).toMatchObject({ type: "poll", poll: { question: "Кто?", answers: ["Я", "Ты"] } });
    expect(
      describeMedia({
        className: "MessageMediaDocument",
        document: {
          mimeType: "video/mp4",
          attributes: [{ className: "DocumentAttributeVideo", duration: 12 }, { className: "DocumentAttributeFilename", fileName: "clip.mp4" }],
        },
      }),
    ).toMatchObject({ type: "video", duration: 12, fileName: "clip.mp4" });
  });

  it("склеивает соседние куски оформления", () => {
    expect(tidyMarkdown("**MellSher****, ****5opka**** — Opus**")).toBe("**MellSher, 5opka — Opus**");
    expect(tidyMarkdown("**Magnum**** ****Opus**** — это...**")).toBe("**Magnum Opus — это...**");
    expect(tidyMarkdown("__курсив__ и **жирный**")).toBe("__курсив__ и **жирный**");
  });

  it("служебные сообщения не посты", () => {
    expect(isPost({ className: "MessageService", id: 1 })).toBe(false);
    expect(isPost({ className: "Message", id: 1 })).toBe(true);
  });

  it("ссылка на пост", () => {
    expect(postLink({ id: 1, username: "durov" }, 5)).toBe("https://t.me/durov/5");
    expect(postLink({ id: 123, username: null }, 5)).toBe("https://t.me/c/123/5");
  });
});

describe("нарезка", () => {
  it("короткий пост — один кусок с шапкой", () => {
    const [chunk, ...rest] = buildChunks({ channelTitle: "Канал", date: new Date("2026-03-05T10:00:00Z"), text: "Текст" });
    expect(rest).toHaveLength(0);
    expect(chunk).toBe("Канал: Канал\nДата: 2026-03-05\n\nТекст");
  });

  it("длинный режется по границам с перекрытием и ничего не теряет", () => {
    const text = Array.from({ length: 300 }, (_, i) => `Предложение номер ${i}.`).join(" ");
    const chunks = splitText(text, 500, 50);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
    expect(chunks.at(-1)).toContain("Предложение номер 299.");
    for (let i = 0; i < 300; i += 37) expect(chunks.some((c) => c.includes(`номер ${i}.`))).toBe(true);
  });

  it("пустой текст — без кусков", () => {
    expect(splitText("   ")).toEqual([]);
  });
});

const post = (channelId: number, messageId: number, extra: Partial<Post> = {}): Post =>
  ({ channelId, messageId, text: "", groupedId: null, media: null, link: "", ...extra }) as Post;

describe("выдача", () => {
  it("RRF поднимает то, что нашлось обоими способами", () => {
    const a = { post: post(1, 1), score: 0.9 };
    const b = { post: post(1, 2), score: 0.8 };
    const c = { post: post(1, 3), score: 0.7 };
    const fused = fuseRankings([[a, b], [c, b]], 3);
    expect(fused[0]!.post.messageId).toBe(2);
    expect(fused).toHaveLength(3);
  });

  it("альбом сворачивается в один пост с подписью", () => {
    const list = collapseAlbums([
      post(1, 1, { text: "", groupedId: "g" }),
      post(1, 2, { text: "Подпись", groupedId: "g" }),
      post(1, 3, { text: "Отдельный" }),
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]!.text).toBe("Подпись");
    expect(list[0]!.album).toHaveLength(2);
  });
});
