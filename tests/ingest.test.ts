/**
 * Чтение каналов с подменённым клиентом: сети нет, но сущности и сообщения —
 * настоящие классы Api из teleproto, как их отдаёт библиотека.
 */

import bigInt from "big-integer";
import { Api } from "teleproto";
import { afterAll, describe, expect, it } from "vitest";
import { Ingestor } from "../src/telegram/ingest.ts";
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
    async getMessages(_peer: unknown, params: { limit: number }) {
      return [...client.history].sort((a, b) => b.id - a.id).slice(0, params.limit);
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
