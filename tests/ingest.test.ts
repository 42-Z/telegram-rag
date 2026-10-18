/**
 * Чтение каналов с подменённым клиентом: сети нет, но сущности и сообщения —
 * настоящие классы Api из teleproto, как их отдаёт библиотека.
 */

import bigInt from "big-integer";
import { Api } from "teleproto";
import { afterAll, describe, expect, it } from "vitest";
import { Ingestor } from "../src/telegram/ingest.ts";
import { normalizeMessage } from "../src/telegram/normalize.ts";
import { freshStore } from "./helpers.ts";

const CHANNEL_ID = 777;

const entity = new Api.Channel({
  id: bigInt(CHANNEL_ID),
  accessHash: bigInt(4242),
  title: "Живой канал",
  username: "live",
  photo: new Api.ChatPhotoEmpty(),
  date: 0,
  broadcast: true,
});

const makeMessage = (id: number, text: string, extra: Record<string, unknown> = {}) =>
  new Api.Message({
    id,
    peerId: new Api.PeerChannel({ channelId: bigInt(CHANNEL_ID) }),
    date: 1_780_000_000 + id * 60,
    message: text,
    post: true,
    views: id * 10,
    ...extra,
  } as never);

function fakeClient(history: Api.TypeMessage[]) {
  const handlers: Record<string, (update: any, next: () => Promise<void>) => unknown> = {};
  let watcher: ((update: any) => unknown) | undefined;
  let watchedPeers: unknown[] = [];
  const client = {
    history,
    iterCalls: [] as any[],
    downloadCalls: 0,
    async connect() {},
    async disconnect() {},
    async getMe() {
      return new Api.User({ id: bigInt(1), username: "bot" } as never);
    },
    async getEntity() {
      return entity;
    },
    async invoke(request: unknown) {
      if (request instanceof Api.channels.GetFullChannel) {
        return { fullChat: { about: "Описание канала" } };
      }
      throw new Error("unexpected invoke");
    },
    iterMessages(_peer: unknown, params: { reverse?: boolean; minId?: number; limit?: number }) {
      client.iterCalls.push(params);
      let list = [...client.history].sort((a, b) => b.id - a.id);
      if (params.minId) list = list.filter((m) => m.id > params.minId!);
      if (params.limit) list = list.slice(0, params.limit);
      if (params.reverse) list.reverse();
      return (async function* () {
        yield* list;
      })();
    },
    async getMessages(_peer: unknown, params: { limit?: number; ids?: number | number[] }) {
      if (params.ids !== undefined) {
        const ids = new Set(Array.isArray(params.ids) ? params.ids : [params.ids]);
        return client.history.filter((message) => ids.has(message.id));
      }
      return [...client.history].sort((a, b) => b.id - a.id).slice(0, params.limit);
    },
    async downloadMedia() {
      client.downloadCalls += 1;
      return Buffer.from("telegram-original");
    },
    updates: {
      on(name: string, handler: any) {
        handlers[name] = handler;
        return () => {};
      },
      catch() {},
      watch(peers: unknown[], handler: any) {
        watchedPeers = peers;
        watcher = handler;
        return () => {
          watcher = undefined;
        };
      },
    },
    emit: (update: unknown) => watcher?.(update),
    emitRaw: (name: string, update: unknown) => handlers[name]?.(update, async () => {}),
    watched: () => watchedPeers,
  };
  return client;
}

const { db, store } = await freshStore();
afterAll(() => db.close());

describe("Ingestor", () => {
  const history = [
    makeMessage(1, "Первый пост канала"),
    new Api.MessageService({
      id: 2,
      peerId: new Api.PeerChannel({ channelId: bigInt(CHANNEL_ID) }),
      date: 1_780_000_120,
      action: new Api.MessageActionPinMessage(),
    } as never),
    makeMessage(3, "Третий пост", { groupedId: bigInt(55), media: new Api.MessageMediaPhoto({}) }),
    makeMessage(4, "", { groupedId: bigInt(55), media: new Api.MessageMediaPhoto({}) }),
  ];
  const client = fakeClient([...history]);
  let notified = 0;
  const ingestor = new Ingestor(client as never, store, {
    backfillLimit: 0,
    pollIntervalSeconds: 3600,
    onPosts: () => notified++,
  });

  it("добавляет канал и читает историю от старых к новым", async () => {
    const channel = await ingestor.addChannel("https://t.me/live", { sync: false });
    expect(channel).toMatchObject({ id: CHANNEL_ID, username: "live", title: "Живой канал", about: "Описание канала" });
    await ingestor.syncChannel(channel);

    expect(client.iterCalls[0]).toMatchObject({ reverse: true, minId: 0 });
    const { posts, total } = await store.listPosts({ order: "oldest", limit: 10 });
    expect(total).toBe(3); // служебное сообщение пропущено
    expect(posts.map((p) => p.messageId)).toEqual([1, 3, 4]);
    expect(posts[1]).toMatchObject({ groupedId: "55", media: { type: "photo" }, views: 30, link: "https://t.me/live/3" });
    expect(notified).toBeGreaterThan(0);

    const [saved] = await store.listChannels();
    expect(saved).toMatchObject({ lastMessageId: 4, backfillDone: true });
  });

  it("следующий опрос читает только новое", async () => {
    client.history.push(makeMessage(5, "Пятый пост"));
    const [channel] = await store.listChannels();
    await ingestor.syncChannel(channel!);
    expect(client.iterCalls.at(-1)).toMatchObject({ reverse: true, minId: 4 });
    expect((await store.getPost(CHANNEL_ID, 5))?.text).toBe("Пятый пост");
    expect((await store.listChannels())[0]!.lastMessageId).toBe(5);
  });

  it("не скачивает файл, если Telegram уже заменил вложение в сообщении", async () => {
    await ingestor.addChannel("@live", { sync: false });
    const mediaMessage = makeMessage(8, "Файл");
    (mediaMessage as any).media = {
      className: "MessageMediaDocument",
      document: {
        id: bigInt(123),
        mimeType: "audio/ogg",
        size: 12,
        attributes: [{ className: "DocumentAttributeAudio", voice: true, duration: 2 }],
      },
    };
    client.history.push(mediaMessage);
    const original = normalizeMessage(CHANNEL_ID, mediaMessage).media!;
    expect(original.fileId).toBe("123");
    await expect(ingestor.downloadMedia(CHANNEL_ID, 8, original)).resolves.toEqual(Buffer.from("telegram-original"));
    expect(client.downloadCalls).toBe(1);
    (mediaMessage as any).media.document.id = bigInt(456);

    await expect(ingestor.downloadMedia(CHANNEL_ID, 8, original)).rejects.toThrow(/изменилось/);
    expect(client.downloadCalls).toBe(1);
    client.history.splice(client.history.indexOf(mediaMessage), 1);
  });

  it("живые обновления: новый пост, правка, удаление", async () => {
    await (ingestor as any).rewatch();
    expect(client.watched()).toHaveLength(1);

    await client.emit(new Api.UpdateNewChannelMessage({ message: makeMessage(6, "Живой пост"), pts: 1, ptsCount: 1 }));
    expect((await store.getPost(CHANNEL_ID, 6))?.text).toBe("Живой пост");
    // живое обновление не двигает отметку «прочитано до»
    expect((await store.listChannels())[0]!.lastMessageId).toBe(5);

    await client.emit(
      new Api.UpdateEditChannelMessage({
        message: makeMessage(6, "Живой пост (исправлено)", { editDate: 1_780_001_000 }),
        pts: 2,
        ptsCount: 1,
      }),
    );
    const edited = await store.getPost(CHANNEL_ID, 6);
    expect(edited?.text).toBe("Живой пост (исправлено)");
    expect(edited?.editDate).toBeTruthy();

    // пост из чужого канала не сохраняется
    const foreign = makeMessage(7, "Чужой");
    foreign.peerId = new Api.PeerChannel({ channelId: bigInt(999) });
    await client.emit(new Api.UpdateNewChannelMessage({ message: foreign, pts: 3, ptsCount: 1 }));
    expect(await store.getPost(999, 7)).toBeUndefined();

    await ingestor.start([]).catch(() => {}); // регистрирует обработчик удалений
    await client.emitRaw(
      "deleteChannelMessages",
      new Api.UpdateDeleteChannelMessages({ channelId: bigInt(CHANNEL_ID), messages: [6], pts: 4, ptsCount: 1 }),
    );
    expect((await store.getPost(CHANNEL_ID, 6))?.deleted).toBe(true);
    expect((await store.listPosts({ limit: 10 })).total).toBe(4);
    await ingestor.stop();
  });

  it("остановка посреди истории сохраняет прочитанное и не помечает канал дочитанным", async () => {
    const other = await freshStore();
    const client = fakeClient([...history]);
    let stopper: Promise<void> | undefined;
    const interrupted = new Ingestor(client as never, other.store, { backfillLimit: 0, pollIntervalSeconds: 3600 });
    client.iterMessages = (() =>
      (async function* () {
        yield history[0]!;
        stopper = interrupted.stop(); // сигнал остановки приходит, пока канал ещё читается
        yield history[2]!;
        yield history[3]!;
      })()) as never;
    const channel = await interrupted.addChannel("@live", { sync: false });
    await interrupted.syncChannel(channel);
    await stopper;

    const { posts } = await other.store.listPosts({ order: "oldest", limit: 10 });
    expect(posts.map((p) => p.messageId)).toEqual([1]);
    expect((await other.store.listChannels())[0]).toMatchObject({ lastMessageId: 1, backfillDone: false });
    await other.db.close();
  });

  it("BACKFILL_LIMIT берёт только последние посты", async () => {
    const other = await freshStore();
    const limited = new Ingestor(fakeClient([...history]) as never, other.store, { backfillLimit: 2, pollIntervalSeconds: 3600 });
    const channel = await limited.addChannel("@live", { sync: false });
    await limited.syncChannel(channel);
    const { posts } = await other.store.listPosts({ order: "oldest", limit: 10 });
    expect(posts.map((p) => p.messageId)).toEqual([3, 4]);
    expect((await other.store.listChannels())[0]).toMatchObject({ lastMessageId: 4, backfillDone: true });
    await other.db.close();
  });
});
