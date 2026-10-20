/**
 * Каналы вне пула: чтение из Telegram через подменённый источник, временный
 * кэш, отсутствие поиска и удаление по сроку.
 */

import bigInt from "big-integer";
import { Api } from "teleproto";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import type { ResolvedChannel } from "../src/telegram/client.ts";
import { parseChannelRef } from "../src/telegram/client.ts";
import type { ChannelSource, HistoryParams } from "../src/telegram/reader.ts";
import { GuestReader } from "../src/telegram/reader.ts";
import type { MessageLike } from "../src/telegram/normalize.ts";
import { fakeEmbedder, freshStore, message } from "./helpers.ts";

const CHANNEL_ID = 5001;

const channel: ResolvedChannel = {
  id: CHANNEL_ID,
  username: "outside",
  title: "Вне пула",
  about: "Канал, за которым сервис не следит",
  accessHash: "42",
  peer: new Api.InputPeerChannel({ channelId: bigInt(CHANNEL_ID), accessHash: bigInt(42) }),
};

const history: MessageLike[] = [
  message(1, "Первый пост"),
  message(2, "Второй пост"),
  message(3, "", { groupedId: { toString: () => "album" }, media: { className: "MessageMediaPhoto" } }),
  message(4, "Подпись к альбому", { groupedId: { toString: () => "album" }, media: { className: "MessageMediaPhoto" } }),
  message(5, "Пятый пост"),
];

class FakeSource implements ChannelSource {
  /** История и сообщения, которые Telegram отдаёт прямо сейчас. */
  items: MessageLike[];
  calls: HistoryParams[] = [];
  fail = false;
  private readonly entity: ResolvedChannel;
  private readonly username: string;

  constructor(entity: ResolvedChannel = channel, username = "outside", items: MessageLike[] = [...history]) {
    this.entity = entity;
    this.username = username;
    this.items = items;
  }

  async resolve(ref: string): Promise<ResolvedChannel> {
    if (this.fail) throw new Error("telegram unavailable");
    const parsed = parseChannelRef(ref);
    if (parsed.kind !== "username" || parsed.value !== this.username) throw new Error("нет такого публичного канала");
    return this.entity;
  }

  async history(_peer: ResolvedChannel["peer"], params: HistoryParams): Promise<MessageLike[]> {
    if (this.fail) throw new Error("telegram unavailable");
    this.calls.push(params);
    const list = this.items
      .filter((item) => {
        if (params.minId !== undefined && item.id <= params.minId) return false;
        if (params.maxId !== undefined && item.id >= params.maxId) return false;
        if (params.offsetId !== undefined && item.id >= params.offsetId) return false;
        return true;
      })
      .sort((a, b) => params.reverse ? a.id - b.id : b.id - a.id);
    return list.slice(0, params.limit);
  }

  async message(_peer: ResolvedChannel["peer"], id: number): Promise<MessageLike | undefined> {
    if (this.fail) throw new Error("telegram unavailable");
    return this.items.find((item) => item.id === id);
  }
}

const { db, store } = await freshStore();
const source = new FakeSource();
const guest = new GuestReader(store, source, { ttlSeconds: 3600, maxChannels: 10 });
const app = createApp({ context: { store, embedder: fakeEmbedder(), guests: guest } });
afterAll(() => db.close());

const call = async (name: string, args: unknown) => {
  const response = await app.request(`/api/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as any };
};

describe("каналы вне пула", () => {
  it("читает ленту из Telegram и сохраняет её во временный кэш", async () => {
    const page = await guest.read("@outside", { limit: 3 });
    expect(page.fromCache).toBe(false);
    expect(page.posts.map((post) => post.messageId)).toEqual([5, 4, 3]);
    expect(page.channel).toMatchObject({ id: CHANNEL_ID, username: "outside", title: "Вне пула" });
    expect(page.channel.expiresAt).toBeInstanceOf(Date);
    expect(page.channel.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(page.hasMore).toBe(true);
    expect(page.nextBeforeMessageId).toBe(3);

    // В обычную ленту, статистику и очередь индексации гости не попадают.
    expect((await store.listPosts({ limit: 10 })).total).toBe(0);
    expect(await store.listChannels()).toHaveLength(0);
    expect(await store.channelStats()).toHaveLength(0);
    expect(await store.pendingForEmbedding(10)).toHaveLength(0);
    expect(await store.keywordSearch("Первый пост", {}, 10)).toHaveLength(0);

    // И поиск по ним честно отказывает.
    const search = await call("search_posts", { query: "Первый", channels: ["@outside"] });
    expect(search.status).toBe(400);
    expect(search.body.error).toContain("вне пула");
  });

  it("перелистывает вглубь и добирает новее", async () => {
    const older = await call("list_posts", { channel: "@outside", before_message_id: 3, limit: 2 });
    expect(older.status).toBe(200);
    expect(older.body.posts.map((post: any) => post.message_id)).toEqual([2, 1]);
    expect(older.body.next_before_message_id).toBe(1);

    const newer = await guest.read("@outside", { afterMessageId: 2, limit: 3 });
    expect(newer.posts.map((post) => post.messageId)).toEqual([5, 4, 3]);

    const newerPage = await call("list_posts", { channel: "@outside", after_message_id: 2, limit: 3 });
    expect(newerPage.body.posts.map((post: any) => post.message_id)).toEqual([5, 4]);
    expect(newerPage.body.next_before_message_id).toBe(3);

    const range = await guest.read("@outside", { afterMessageId: 1, beforeMessageId: 5, limit: 10 });
    expect(range.posts.map((post) => post.messageId)).toEqual([4, 3, 2]);
  });

  it("фильтрует документы во внешнем канале, не теряя страницу", async () => {
    const docsEntity: ResolvedChannel = {
      id: 5002,
      username: "docs",
      title: "Документы",
      about: null,
      accessHash: "43",
      peer: new Api.InputPeerChannel({ channelId: bigInt(5002), accessHash: bigInt(43) }),
    };
    const docsSource = new FakeSource(docsEntity, "docs", [
      message(1, "Текст без файла"),
      message(2, "Первый документ", {
        media: {
          className: "MessageMediaDocument",
          document: {
            id: { toString: () => "8001" },
            mimeType: "application/pdf",
            attributes: [{ className: "DocumentAttributeFilename", fileName: "first.pdf" }],
          },
        },
      }),
      message(3, "Ещё текст"),
      message(4, "Второй документ", {
        media: {
          className: "MessageMediaDocument",
          document: {
            id: { toString: () => "8002" },
            mimeType: "application/pdf",
            attributes: [{ className: "DocumentAttributeFilename", fileName: "second.pdf" }],
          },
        },
      }),
    ]);
    const docsReader = new GuestReader(store, docsSource, { ttlSeconds: 3600, maxChannels: 10 });

    const first = await docsReader.read("@docs", { limit: 1, mediaTypes: ["document"] });
    expect(first.posts.map((post) => post.messageId)).toEqual([4]);
    expect(first.nextBeforeMessageId).toBe(4);

    const second = await docsReader.read("@docs", {
      limit: 5,
      mediaTypes: ["document"],
      beforeMessageId: first.nextBeforeMessageId,
    });
    expect(second.posts.map((post) => post.messageId)).toEqual([2]);
  });

  it("дочитывает альбом, обрезанный краем страницы", async () => {
    const page = await guest.read("@outside", { limit: 1 });
    expect(page.posts.map((post) => post.messageId)).toEqual([5]);
    expect(page.hasMore).toBe(true);

    const last = await guest.read("@outside", { limit: 2 });
    expect(last.posts.map((post) => post.messageId)).toEqual([5, 4, 3]);
    const older = await guest.read("@outside", { beforeMessageId: 5, limit: 1 });
    expect(older.posts.map((post) => post.messageId).sort()).toEqual([3, 4]);
  });

  it("get_post собирает альбом, ответ и соседей", async () => {
    const result = await guest.getPost("@outside", 4, { context: 1 });
    expect(result?.post.text).toBe("Подпись к альбому");
    expect(result?.album.map((post) => post.messageId)).toEqual([3, 4]);
    expect(result?.before.map((post) => post.messageId)).toEqual([2]);
    expect(result?.after.map((post) => post.messageId)).toEqual([5]);

    const tool = await call("get_post", { link: "https://t.me/outside/4", context: 1 });
    expect(tool.status).toBe(200);
    expect(tool.body).toMatchObject({ outside_pool: true, searchable: false, message_id: 4 });
    expect(tool.body.cache_expires_at).toBeTruthy();
    expect(tool.body.album).toHaveLength(2);
    expect(tool.body.before[0].message_id).toBe(2);
    expect(tool.body.after[0].message_id).toBe(5);
  });

  it("list_posts отдаёт альбом одним постом и не выдаёт ссылки на несохранённые вложения", async () => {
    const response = await call("list_posts", { channel: "https://t.me/outside", limit: 3 });
    expect(response.status).toBe(200);
    expect(response.body.posts.map((post: any) => post.message_id)).toEqual([5, 4]);
    expect(response.body.posts[1].channel).toBeUndefined();
    expect(response.body.posts[1].channel_username).toBeUndefined();
    expect(response.body.notice).toBeUndefined();
    expect(response.body.source).toBeUndefined();
    const album = response.body.posts[1];
    expect(album.album).toHaveLength(2);
    expect(album.media).toMatchObject({ type: "photo" });
    expect(album.media.url).toBeUndefined();
    expect(album.media.archived).toBeUndefined();
    expect(album.media.download_error).toBeUndefined();
  });

  it("не вступает в закрытые каналы и понятно отказывает", async () => {
    const invite = await call("list_posts", { channel: "https://t.me/+AbCdEf" });
    expect(invite.status).toBe(400);
    expect(invite.body.error).toContain("только публичные каналы");

    const missing = await call("list_posts", { channel: "@missing" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("не прочитан");
  });

  it("без Telegram отдаёт ещё живой кэш", async () => {
    source.fail = true;
    const page = await guest.read("@outside", { limit: 2 });
    expect(page.fromCache).toBe(true);
    expect(page.posts.map((post) => post.messageId)).toEqual([5, 4]);
    expect(page.notice).toContain("кэш");

    const result = await guest.getPost("@outside", 4, { context: 0 });
    expect(result?.fromCache).toBe(true);
    expect(result?.post.messageId).toBe(4);

    const neighbors = await guest.getPost("@outside", 2, { context: 1 });
    expect(neighbors?.fromCache).toBe(true);
    expect(neighbors?.before.map((post) => post.messageId)).toEqual([1]);
    expect(neighbors?.after.map((post) => post.messageId)).toEqual([3]);
    source.fail = false;
  });

  it("оставляет не больше заданного числа каналов", async () => {
    const other = await freshStore();
    try {
      const limited = new GuestReader(other.store, source, { ttlSeconds: 3600, maxChannels: 1 });
      await limited.read("@outside", { limit: 1 });
      await other.store.upsertGuestChannel({
        id: 5002, ref: "@second", username: "second", title: "Второй", about: null, accessHash: "2",
      }, 3600);
      await other.store.trimGuestChannels(1);
      const channels = await other.store.listChannels({ includeGuest: true });
      expect(channels).toHaveLength(1);
      expect(channels[0]!.username).toBe("second");
    } finally {
      await other.db.close();
    }
  });

  it("удаляет истёкший кэш вместе с постами", async () => {
    const expired = await freshStore();
    try {
      const channel = await expired.store.upsertGuestChannel({
        id: 6001, ref: "@expired", username: "expired", title: "Истёк", about: null, accessHash: "1",
      }, 0);
      await expired.store.upsertPosts([
        {
          channelId: channel.id,
          messageId: 1,
          date: new Date(),
          editDate: null,
          text: "Исчезнет",
          media: null,
          groupedId: null,
          views: null,
          forwards: null,
          replies: null,
          reactions: null,
          replyTo: null,
          forwardedFrom: null,
          postAuthor: null,
          contentHash: "x",
        },
      ]);
      expect(await expired.store.getPost(channel.id, 1)).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await expired.store.purgeExpiredGuestChannels()).toBe(1);
      expect(await expired.store.getPost(channel.id, 1)).toBeUndefined();
      expect(await expired.store.findChannel("@expired")).toBeUndefined();
    } finally {
      await expired.db.close();
    }
  });
});
