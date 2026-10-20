/**
 * Каналы вне пула: чтение из Telegram по запросу и временный кэш.
 *
 * Такой канал не индексируется и не участвует в поиске: посты кладутся в базу
 * только для того, чтобы отдать их целиком здесь и в get_post, а через час
 * после последнего чтения удаляются вместе с каналом.
 * Вложения тоже не архивируются в S3 — остаются в Telegram.
 */

import type { TelegramClient } from "teleproto";
import { logger } from "../log.ts";
import type { Channel, Post, Store } from "../store.ts";
import { type ResolvedChannel, parseChannelRef, resolveChannel } from "./client.ts";
import { type MessageLike, describeMedia, isPost, normalizeMessage } from "./normalize.ts";

const log = logger("guest");

export class GuestScanLimitError extends Error {}

/** Сколько сообщений Telegram отдаёт за один запрос истории. */
const MAX_FETCH = 100;
/** Предохранитель от чтения всей истории гостевого канала за один запрос. */
const MAX_GUEST_SCAN_MESSAGES = 2_000;
/** Запас по номерам сообщений вокруг края альбома. */
const ALBUM_MARGIN = 10;
/** Сколько соседних сообщений запрашивать вокруг альбома. */
const ALBUM_WINDOW = ALBUM_MARGIN * 2 + 2;

/**
 * Каналы вне пула — временный кэш с фиксированными пределами, без настроек
 * окружения: час после последнего чтения и не больше сотни каналов.
 */
export const GUEST_CACHE = {
  ttlSeconds: 3600,
  maxChannels: 100,
} as const;

export interface HistoryParams {
  limit: number;
  offsetId?: number;
  /** Unix-время в секундах: смотреть только сообщения старше него. */
  offsetDate?: number;
  minId?: number;
  maxId?: number;
  reverse?: boolean;
}

/** Клиент Telegram в том виде, который нужен чтению каналов вне пула. */
export interface ChannelSource {
  resolve(
    ref: string,
    known?: { id: number; accessHash: string | null; username: string | null; about?: string | null },
  ): Promise<ResolvedChannel>;
  history(peer: ResolvedChannel["peer"], params: HistoryParams): Promise<MessageLike[]>;
  message(peer: ResolvedChannel["peer"], id: number): Promise<MessageLike | undefined>;
}

export function createChannelSource(client: TelegramClient): ChannelSource {
  return {
    resolve: (ref, known) => resolveChannel(client, ref, known),
    history: async (peer, params) =>
      (await client.getMessages(peer, params)) as unknown as MessageLike[],
    message: async (peer, id) => {
      const [message] = (await client.getMessages(peer, { ids: id })) as unknown as Array<MessageLike | undefined>;
      return message;
    },
  };
}

export interface GuestReaderOptions {
  ttlSeconds: number;
  maxChannels: number;
}

export interface GuestEnsureOptions {
  /** Сколько постов должно быть в кэше, чтобы страница с offset+limit поместилась. */
  needed: number;
  dateFrom?: Date;
  dateTo?: Date;
  mediaTypes?: readonly string[];
}

export interface GuestEnsureResult {
  channel: Channel;
  /** История закончилась или достигнута нижняя граница дат. */
  complete: boolean;
  notice?: string;
}

export interface GuestPostResult {
  channel: Channel;
  post: Post;
  album: Post[];
  replyTo?: Post;
  before: Post[];
  after: Post[];
  fromCache: boolean;
  notice?: string;
}

export class GuestReader {
  private readonly store: Store;
  private readonly source: ChannelSource;
  private readonly options: GuestReaderOptions;
  private readonly ensureQueues = new Map<string, Promise<unknown>>();

  constructor(store: Store, source: ChannelSource, options: GuestReaderOptions) {
    this.store = store;
    this.source = source;
    this.options = options;
  }

  /**
   * Догружает историю гостевого канала в кэш, чтобы дальше читать её тем же
   * SQL-фильтром, что и канал пула: даты, offset и media_types.
   */
  async ensurePosts(ref: string, options: GuestEnsureOptions): Promise<GuestEnsureResult> {
    const previous = this.ensureQueues.get(ref) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.ensurePostsWork(ref, options));
    this.ensureQueues.set(ref, task);
    try {
      return await task;
    } finally {
      if (this.ensureQueues.get(ref) === task) this.ensureQueues.delete(ref);
    }
  }

  private async ensurePostsWork(ref: string, options: GuestEnsureOptions): Promise<GuestEnsureResult> {
    this.assertPublic(ref);
    const known = await this.store.findChannel(ref);
    const cached = isFresh(known) ? known : undefined;
    try {
      const resolved = await this.source.resolve(ref, cached ?? undefined);
      await this.store.trimGuestChannels(this.options.maxChannels);
      const channel = await this.store.upsertGuestChannel(
        { ...resolved, ref: known?.ref ?? ref },
        this.options.ttlSeconds,
      );

      let offsetDate = options.dateTo ? Math.floor(options.dateTo.getTime() / 1_000) + 1 : undefined;
      let offsetId: number | undefined;
      let complete = false;
      let matched = 0;
      let scanned = 0;
      while (true) {
        const raw = await this.source.history(resolved.peer, {
          limit: MAX_FETCH,
          ...(offsetDate ? { offsetDate } : { offsetId }),
        });
        if (raw.length === 0) {
          complete = true;
          break;
        }
        scanned += raw.length;

        const posts = raw.filter(isPost);
        await this.save(channel.id, await this.completeAlbums(resolved.peer, posts));

        // Считаем совпадения по самой истории Telegram, а не по кэшу:
        // в кэше могут быть дыры от get_post и прошлых запросов с датами.
        for (const message of posts) {
          const date = (message.date ?? 0) * 1_000;
          if (options.dateFrom && date < options.dateFrom.getTime()) continue;
          if (options.dateTo && date > options.dateTo.getTime()) continue;
          const type = describeMedia(message.media)?.type;
          if (options.mediaTypes && (!type || !options.mediaTypes.includes(type))) continue;
          matched += 1;
        }
        if (matched >= options.needed) break;

        const oldest = Math.min(...raw.map((message) => message.date ?? 0));
        if (options.dateFrom && oldest * 1_000 < options.dateFrom.getTime()) {
          complete = true;
          break;
        }
        if (scanned >= MAX_GUEST_SCAN_MESSAGES) {
          throw new GuestScanLimitError(
            `история канала слишком глубокая: просмотрено ${scanned} сообщений, но нужного количества постов не набралось. ` +
              "Уточните date_from или date_to",
          );
        }
        if (raw.length < MAX_FETCH) {
          complete = true;
          break;
        }

        offsetDate = undefined;
        offsetId = Math.min(...raw.map((message) => message.id));
      }
      return { channel, complete };
    } catch (error) {
      if (error instanceof GuestScanLimitError) throw error;
      // Telegram недоступен, но в кэше уже что-то есть — отдадим его.
      if (cached) {
        return {
          channel: cached,
          complete: false,
          notice: "Telegram недоступен — показан сохранённый кэш канала",
        };
      }
      throw error;
    }
  }

  /** Один пост канала вне пула с альбомом, ответом и соседями. */
  async getPost(
    ref: string,
    messageId: number,
    options: { context?: number } = {},
  ): Promise<GuestPostResult | undefined> {
    this.assertPublic(ref);
    const known = await this.store.findChannel(ref);
    const cached = isFresh(known) ? known : undefined;
    try {
      const resolved = await this.source.resolve(ref, cached ?? undefined);
      await this.store.trimGuestChannels(this.options.maxChannels);
      const channel = await this.store.upsertGuestChannel(
        { ...resolved, ref: known?.ref ?? ref },
        this.options.ttlSeconds,
      );

      const message = await this.source.message(resolved.peer, messageId);
      if (!message || !isPost(message)) {
        const fromCache = cached ? await this.cachedPost(cached, messageId, options.context) : undefined;
        return fromCache
          ? {
              ...fromCache,
              fromCache: true,
              notice: "Telegram больше не отдаёт этот пост — показан сохранённый кэш",
            }
          : undefined;
      }

      const collected = new Map<number, MessageLike>([[message.id, message]]);
      if (message.groupedId) {
        for (const item of await this.albumAround(resolved.peer, message.groupedId.toString(), message.id)) {
          collected.set(item.id, item);
        }
      }
      if (message.replyTo?.replyToMsgId) {
        const reply = await this.source.message(resolved.peer, message.replyTo.replyToMsgId);
        if (reply && isPost(reply)) collected.set(reply.id, reply);
      }
      const context = options.context ?? 0;
      if (context > 0) {
        const older = await this.source.history(resolved.peer, {
          limit: context + 10,
          offsetId: messageId,
        });
        for (const item of older.filter(isPost)) {
          if (item.id !== messageId && item.groupedId !== message.groupedId) collected.set(item.id, item);
        }
        const newer = await this.source.history(resolved.peer, {
          limit: context + 10,
          minId: messageId,
          reverse: true,
        });
        for (const item of newer.filter(isPost)) {
          if (item.id !== messageId && item.groupedId !== message.groupedId) collected.set(item.id, item);
        }
      }

      await this.save(channel.id, [...collected.values()]);
      const posts = await this.store.getPosts(channel.id, [...collected.keys()]);
      const byId = new Map(posts.map((post) => [post.messageId, post]));
      const post = byId.get(messageId);
      if (!post) return undefined;

      const album = message.groupedId
        ? posts.filter((item) => item.groupedId === message.groupedId?.toString()).sort((a, b) => a.messageId - b.messageId)
        : [];
      const replyTo = message.replyTo?.replyToMsgId ? byId.get(message.replyTo.replyToMsgId) : undefined;
      const neighbors = [...collected.values()]
        .filter((item) =>
          item.id !== messageId &&
          item.id !== message.replyTo?.replyToMsgId &&
          !(message.groupedId && item.groupedId?.toString() === message.groupedId.toString()))
        .map((item) => byId.get(item.id))
        .filter((item): item is Post => Boolean(item));
      const before = context > 0
        ? neighbors
            .filter((item) => item.messageId < messageId)
            .sort((a, b) => a.messageId - b.messageId)
            .slice(-context)
        : [];
      const after = context > 0
        ? neighbors
            .filter((item) => item.messageId > messageId)
            .sort((a, b) => a.messageId - b.messageId)
            .slice(0, context)
        : [];

      return {
        channel,
        post,
        album: album.length > 1 ? album : [],
        replyTo,
        before,
        after,
        fromCache: false,
      };
    } catch (error) {
      if (cached) {
        const result = await this.cachedPost(cached, messageId, options.context);
        if (result) {
          log.warn(`Telegram не ответил, отдаю кэш ${cached.title}`, error);
          return {
            ...result,
            fromCache: true,
            notice: `Telegram сейчас недоступен — показан сохранённый кэш до ${iso(cached.expiresAt)}`,
          };
        }
      }
      throw error;
    }
  }

  private async cachedPost(channel: Channel, messageId: number, context = 0): Promise<GuestPostResult | undefined> {
    const post = await this.store.getPost(channel.id, messageId);
    if (!post || post.deleted) return undefined;
    const album = post.groupedId ? await this.store.getAlbum(channel.id, post.groupedId) : [];
    const replyTo = post.replyTo ? await this.store.getPost(channel.id, post.replyTo) : undefined;
    let before: Post[] = [];
    let after: Post[] = [];
    if (context > 0) {
      const older = await this.store.listPosts({
        channelIds: [channel.id],
        includeGuest: true,
        beforeMessageId: messageId,
        order: "newest",
        limit: context + album.length + 1,
      });
      before = older.posts
        .filter((item) => item.messageId !== messageId && !(post.groupedId && item.groupedId === post.groupedId))
        .slice(0, context)
        .reverse();
      const newer = await this.store.listPosts({
        channelIds: [channel.id],
        includeGuest: true,
        afterMessageId: messageId,
        order: "oldest",
        limit: context + album.length + 1,
      });
      after = newer.posts
        .filter((item) => item.messageId !== messageId && !(post.groupedId && item.groupedId === post.groupedId))
        .slice(0, context);
    }
    return {
      channel,
      post,
      album: album.length > 1 ? album : [],
      replyTo,
      before,
      after,
      fromCache: true,
    };
  }

  private async save(channelId: number, messages: readonly MessageLike[]): Promise<void> {
    if (messages.length === 0) return;
    const unique = [...new Map(messages.map((message) => [message.id, message])).values()];
    await this.store.upsertPosts(unique.map((message) => normalizeMessage(channelId, message)));
  }

  /**
   * Дочитывает части альбомов, которые обрезались краем страницы. Внутри окна
   * альбом уже полный, поэтому запросы идут только для групп на границах.
   */
  private async completeAlbums(peer: ResolvedChannel["peer"], messages: readonly MessageLike[]): Promise<MessageLike[]> {
    if (messages.length === 0) return [];
    const ids = messages.map((message) => message.id);
    const windowMin = Math.min(...ids);
    const windowMax = Math.max(...ids);
    const groups = new Map<string, { min: number; max: number }>();
    for (const message of messages) {
      if (!message.groupedId) continue;
      const key = message.groupedId.toString();
      const group = groups.get(key);
      if (group) {
        group.min = Math.min(group.min, message.id);
        group.max = Math.max(group.max, message.id);
      } else {
        groups.set(key, { min: message.id, max: message.id });
      }
    }

    const extras = new Map<number, MessageLike>();
    for (const [key, group] of groups) {
      if (group.min > windowMin && group.max < windowMax) continue;
      const around = await this.source.history(peer, {
        limit: ALBUM_WINDOW,
        offsetId: group.max + ALBUM_MARGIN + 1,
        minId: Math.max(0, group.min - ALBUM_MARGIN - 1),
      });
      for (const message of around) {
        if (message.groupedId?.toString() === key && !ids.includes(message.id)) {
          extras.set(message.id, message);
        }
      }
    }
    return [...messages, ...extras.values()];
  }

  private async albumAround(peer: ResolvedChannel["peer"], groupedId: string, messageId: number): Promise<MessageLike[]> {
    const messages = await this.source.history(peer, {
      limit: ALBUM_WINDOW,
      offsetId: messageId + ALBUM_MARGIN + 1,
      minId: Math.max(0, messageId - ALBUM_MARGIN - 1),
    });
    return messages.filter((message) => message.groupedId?.toString() === groupedId);
  }

  private assertPublic(ref: string): void {
    const parsed = parseChannelRef(ref);
    if (parsed.kind !== "username") {
      throw new Error("вне пула доступны только публичные каналы по @имени или ссылке t.me/<имя>");
    }
  }
}

function isFresh(channel: Channel | undefined): channel is Channel {
  return Boolean(channel?.expiresAt && new Date(channel.expiresAt).getTime() > Date.now());
}

const iso = (date: Date | null | undefined): string => (date ? new Date(date).toISOString() : "");
