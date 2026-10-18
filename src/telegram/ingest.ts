/**
 * Слежение за пулом каналов.
 *
 * Три пути, которыми посты попадают в базу:
 * 1. История — при добавлении канала читается целиком (или последние
 *    BACKFILL_LIMIT постов), от старых к новым, с отметкой прогресса: после
 *    перезапуска чтение продолжается с места остановки.
 * 2. Живые обновления — `client.updates.watch`: новые посты, правки и
 *    удаления приходят сразу. Для публичных каналов вступать не нужно.
 * 3. Догоняющий опрос раз в POLL_INTERVAL_SECONDS — дочитывает всё новее
 *    последнего сохранённого поста и обновляет недавние (просмотры, реакции,
 *    правки). Страхует от обновлений, потерянных при разрыве соединения.
 *
 * Отметку «прочитано до» двигают только история и опрос: они читают подряд,
 * а живое обновление может прийти раньше пропущенного соседа.
 */

import type { Api, TelegramClient } from "teleproto";
import { logger } from "../log.ts";
import type { Channel, Store } from "../store.ts";
import { type ResolvedChannel, resolveChannel } from "./client.ts";
import { isPost, type MessageLike, normalizeMessage, type PostMedia, type PostRecord } from "./normalize.ts";

const log = logger("telegram");

const BATCH = 100;
const RECENT_REFRESH = 30;

export interface IngestOptions {
  backfillLimit: number;
  pollIntervalSeconds: number;
  /** Вызывается, когда в базу легли новые или изменённые посты. */
  onPosts?: () => void;
}

export class Ingestor {
  private readonly peers = new Map<number, ResolvedChannel>();
  private stopWatch: (() => void) | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  /** Каналы, по которым сейчас идёт чтение: второй проход не запускается поверх. */
  private readonly busy = new Set<number>();
  private readonly syncTasks = new Set<Promise<void>>();
  private readonly updateTasks = new Set<Promise<void>>();
  private stopping = false;

  private readonly client: TelegramClient;
  private readonly store: Store;
  private readonly options: IngestOptions;

  constructor(client: TelegramClient, store: Store, options: IngestOptions) {
    this.client = client;
    this.store = store;
    this.options = options;
  }

  async start(seedRefs: readonly string[]): Promise<void> {
    await this.client.connect();
    const me = await this.client.getMe();
    log.info(`вошли как ${(me as Api.User).username ?? (me as Api.User).firstName ?? me.id}`);

    this.client.updates.on("deleteChannelMessages", async (update, next) => {
      const task = (async () => {
        const channelId = Number(update.channelId.toString());
        if (this.peers.has(channelId)) {
          await this.store.markDeleted(channelId, update.messages);
          log.info(`удалены посты ${channelId}: ${update.messages.join(", ")}`);
        }
        await next();
      })();
      await this.track(task, this.updateTasks);
    });
    this.client.updates.catch((error) => log.error("ошибка обработки обновления", error));

    for (const ref of seedRefs) {
      try {
        await this.addChannel(ref, { sync: false });
      } catch (error) {
        log.error(`канал «${ref}» из TELEGRAM_CHANNELS не добавлен`, error);
      }
    }
    await this.reconcile();

    this.pollTimer = setInterval(() => void this.syncAll(), this.options.pollIntervalSeconds * 1000);
    void this.syncAll();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.pollTimer);
    this.stopWatch?.();
    await Promise.allSettled([...this.syncTasks, ...this.updateTasks]);
    await this.client.disconnect();
  }

  private track(task: Promise<void>, active: Set<Promise<void>>): Promise<void> {
    active.add(task);
    void task.then(() => active.delete(task), () => active.delete(task));
    return task;
  }

  /** Добавляет канал в пул и, если нужно, сразу начинает его читать. */
  async addChannel(ref: string, options: { sync?: boolean } = {}): Promise<Channel> {
    const existing = await this.store.findChannel(ref);
    const resolved = await resolveChannel(this.client, ref, existing?.enabled ? existing : undefined);
    const channel = await this.store.upsertChannel({ ...resolved, ref: existing?.ref ?? ref });
    this.peers.set(channel.id, resolved);
    if (options.sync !== false) {
      this.rewatch();
      void this.syncChannel(channel);
    }
    log.info(`канал в пуле: ${channel.title} (${channel.username ? `@${channel.username}` : channel.id})`);
    return channel;
  }

  async removeChannel(channel: Channel, purge: boolean): Promise<void> {
    await this.store.disableChannel(channel.id, purge);
    this.peers.delete(channel.id);
    this.rewatch();
  }

  /** Поднимает сущности всех каналов пула из базы и включает слежение. */
  private async reconcile(): Promise<void> {
    for (const channel of await this.store.listChannels()) {
      if (this.peers.has(channel.id)) continue;
      try {
        const resolved = await resolveChannel(this.client, channel.ref, channel);
        await this.store.upsertChannel({ ...resolved, ref: channel.ref });
        this.peers.set(channel.id, resolved);
      } catch (error) {
        log.error(`канал ${channel.title} недоступен`, error);
      }
    }
    this.rewatch();
  }

  private rewatch(): void {
    this.stopWatch?.();
    const peers = [...this.peers.values()].map((channel) => channel.peer);
    if (peers.length === 0) return;
    this.stopWatch = this.client.updates.watch(
      peers,
      (update: any) => this.track(this.onUpdate(update), this.updateTasks),
      {
        events: ["newChannelMessage", "editChannelMessage"],
      },
    );
    log.info(`слежение за каналами: ${peers.length}`);
  }

  private async onUpdate(update: { message?: MessageLike & { peerId?: { channelId?: unknown } } }): Promise<void> {
    if (this.stopping) return;
    const message = update.message;
    const channelId = Number(message?.peerId?.channelId?.toString());
    if (!message || !this.peers.has(channelId) || !isPost(message)) return;
    await this.store.upsertPosts([normalizeMessage(channelId, message)]);
    log.debug(`пост ${channelId}/${message.id}`);
    this.options.onPosts?.();
  }

  /** Файл медиа поста: сверяем, что Telegram ещё отдаёт исходный fileId. */
  async downloadMedia(channelId: number, messageId: number, expected: PostMedia): Promise<Buffer> {
    const peer = this.peers.get(channelId)?.peer;
    if (!peer) throw new Error("канала нет в пуле");
    const [message] = (await this.client.getMessages(peer, { ids: messageId })) as unknown as Api.Message[];
    if (!message?.media) throw new Error("у сообщения больше нет медиа");
    const current = normalizeMessage(channelId, message).media;
    if (!current) throw new Error("у сообщения больше нет медиа");
    if (expected.fileId ? current.fileId !== expected.fileId : !sameMediaIdentity(current, expected)) {
      throw new Error("вложение в Telegram изменилось после постановки в очередь");
    }
    const file = await this.client.downloadMedia(message, {});
    if (!file || typeof file === "string") throw new Error("файл не скачался");
    return Buffer.from(file);
  }

  syncAll(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return this.track(this.syncAllChannels(), this.syncTasks);
  }

  private async syncAllChannels(): Promise<void> {
    for (const channel of await this.store.listChannels()) {
      if (this.stopping) return;
      await this.syncChannel(channel);
    }
  }

  /** История при первом проходе, дальше — всё новее последнего прочитанного. */
  syncChannel(channel: Channel): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return this.track(this.syncChannelWork(channel), this.syncTasks);
  }

  private async syncChannelWork(channel: Channel): Promise<void> {
    const peer = this.peers.get(channel.id)?.peer;
    if (!peer || this.busy.has(channel.id)) return;
    this.busy.add(channel.id);
    try {
      const firstLimited = !channel.backfillDone && channel.lastMessageId === 0 && this.options.backfillLimit > 0;
      let saved = 0;
      let top = channel.lastMessageId;
      let batch: PostRecord[] = [];

      const flush = async (advance: boolean) => {
        if (batch.length === 0) return;
        await this.store.upsertPosts(batch);
        saved += batch.length;
        batch = [];
        if (advance) await this.store.markSynced(channel.id, { lastMessageId: top });
        this.options.onPosts?.();
      };

      // Первый проход с ограничением идёт от новых к старым (берём последние
      // N), обычный — от старых к новым, чтобы отметка прогресса была верной.
      const iterator = firstLimited
        ? this.client.iterMessages(peer, { limit: this.options.backfillLimit })
        : this.client.iterMessages(peer, { reverse: true, minId: channel.lastMessageId, limit: undefined, waitTime: 1 });

      for await (const message of iterator as AsyncIterable<MessageLike>) {
        top = Math.max(top, message.id);
        if (isPost(message)) batch.push(normalizeMessage(channel.id, message));
        if (batch.length >= BATCH) {
          await flush(!firstLimited);
          if (!channel.backfillDone) log.info(`${channel.title}: прочитано ${saved} постов`);
        }
      }
      await flush(!firstLimited);

      // Недавние посты — ещё раз: просмотры, реакции и правки, пропущенные вживую.
      if (channel.backfillDone) {
        const recent = await this.client.getMessages(peer, { limit: RECENT_REFRESH });
        const posts = (recent as unknown as MessageLike[]).filter(isPost).map((m) => normalizeMessage(channel.id, m));
        await this.store.upsertPosts(posts);
      }

      await this.store.markSynced(channel.id, { lastMessageId: top, backfillDone: true });
      if (saved > 0) log.info(`${channel.title}: сохранено постов ${saved}`);
    } catch (error) {
      log.error(`${channel.title}: чтение прервано, продолжится при следующем опросе`, error);
    } finally {
      this.busy.delete(channel.id);
    }
  }
}

function sameMediaIdentity(left: PostMedia, right: PostMedia): boolean {
  return left.type === right.type &&
    left.fileName === right.fileName &&
    left.mimeType === right.mimeType &&
    left.size === right.size &&
    left.duration === right.duration;
}
