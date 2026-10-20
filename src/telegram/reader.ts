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

/** Сколько сообщений Telegram отдаёт за один запрос истории. */
const MAX_FETCH = 100;
/** Сколько сообщений просматривать в поисках нужного типа, чтобы не зависнуть. */
const MEDIA_SCAN_LIMIT = 500;
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
  minId?: number;
  maxId?: number;
  reverse?: boolean;
}

/** Клиент Telegram в том виде, который нужен чтению каналов вне пула. */
export interface ChannelSource {
  resolve(
    ref: string,
    known?: { id: number; accessHash: string | null; username: string | null },
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

export interface GuestReadOptions {
  limit: number;
  beforeMessageId?: number;
  afterMessageId?: number;
  order?: "newest" | "oldest";
  /** Только посты с вложениями этих типов. */
  mediaTypes?: readonly string[];
}

export interface GuestPage {
  channel: Channel;
  posts: Post[];
  hasMore: boolean;
  nextBeforeMessageId?: number;
  nextAfterMessageId?: number;
  fromCache: boolean;
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

  constructor(store: Store, source: ChannelSource, options: GuestReaderOptions) {
    this.store = store;
    this.source = source;
    this.options = options;
  }

  /** Лента канала вне пула; при недоступном Telegram отдаёт ещё живой кэш. */
  async read(ref: string, options: GuestReadOptions): Promise<GuestPage> {
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

      const limit = options.limit;
      const mediaTypes = options.mediaTypes && options.mediaTypes.length > 0 ? options.mediaTypes : undefined;
      let page: MessageLike[];
      let hasMore: boolean;
      let nextBeforeMessageId: number | undefined;
      let nextAfterMessageId: number | undefined;

      if (!mediaTypes) {
        const fetched = (await this.source.history(resolved.peer, this.historyParams(options, Math.min(MAX_FETCH, limit + 1))))
          .filter(isPost);
        page = fetched.slice(0, limit);
        hasMore = fetched.length > page.length || (limit >= MAX_FETCH && fetched.length >= MAX_FETCH);
        nextBeforeMessageId = page.length > 0 ? Math.min(...page.map((message) => message.id)) : undefined;
        nextAfterMessageId = options.afterMessageId !== undefined && page.length > 0
          ? Math.max(...page.map((message) => message.id))
          : undefined;
      } else {
        const scanned = await this.scanByMediaTypes(resolved.peer, options, limit, mediaTypes);
        page = scanned.messages;
        hasMore = scanned.hasMore;
        nextBeforeMessageId = scanned.nextBeforeMessageId;
        nextAfterMessageId = scanned.nextAfterMessageId;
      }

      const complete = await this.completeAlbums(resolved.peer, page);
      await this.save(channel.id, complete);

      const posts = await this.orderedPosts(channel.id, complete, options.order ?? "newest");
      return {
        channel,
        posts,
        hasMore,
        nextBeforeMessageId: complete.length > 0
          ? Math.min(nextBeforeMessageId ?? Number.MAX_SAFE_INTEGER, ...complete.map((message) => message.id))
          : nextBeforeMessageId,
        nextAfterMessageId: options.afterMessageId !== undefined && complete.length > 0
          ? Math.max(nextAfterMessageId ?? 0, ...complete.map((message) => message.id))
          : nextAfterMessageId,
        fromCache: false,
      };
    } catch (error) {
      if (cached) {
        const page = await this.cachedPage(cached, options);
        if (page.posts.length > 0) {
          log.warn(`Telegram не ответил, отдаю кэш ${cached.title}`, error);
          return {
            ...page,
            fromCache: true,
            notice: `Telegram сейчас недоступен — показан сохранённый кэш канала до ${iso(cached.expiresAt)}`,
          };
        }
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

  /** Сканирует историю страницами, пока не наберёт `limit` постов нужных типов. */
  private async scanByMediaTypes(
    peer: ResolvedChannel["peer"],
    options: GuestReadOptions,
    limit: number,
    mediaTypes: readonly string[],
  ): Promise<{ messages: MessageLike[]; hasMore: boolean; nextBeforeMessageId?: number; nextAfterMessageId?: number }> {
    const forward = options.afterMessageId !== undefined;
    let before = options.beforeMessageId;
    let after = options.afterMessageId;
    let nextBeforeMessageId: number | undefined;
    let nextAfterMessageId: number | undefined;
    let scanned = 0;
    let hasMore = false;
    const matches: MessageLike[] = [];

    while (scanned < MEDIA_SCAN_LIMIT && matches.length < limit) {
      const batch = (await this.source.history(peer, {
        limit: MAX_FETCH,
        ...(forward
          ? { minId: after, maxId: before, reverse: true }
          : { offsetId: before }),
      })).filter(isPost);
      if (batch.length === 0) break;
      scanned += batch.length;
      for (const message of batch) {
        const type = describeMedia(message.media)?.type;
        if (type && mediaTypes.includes(type)) matches.push(message);
      }
      hasMore = batch.length >= MAX_FETCH || matches.length > limit;
      if (forward) {
        nextAfterMessageId = Math.max(...batch.map((message) => message.id));
        after = nextAfterMessageId;
      } else {
        nextBeforeMessageId = Math.min(...batch.map((message) => message.id));
        before = nextBeforeMessageId;
      }
      if (batch.length < MAX_FETCH) break;
    }

    const limited = matches.slice(0, limit);
    if (matches.length > limit) {
      if (forward) nextAfterMessageId = limited[limited.length - 1]!.id;
      else nextBeforeMessageId = limited[limited.length - 1]!.id;
    }

    return {
      messages: limited,
      hasMore,
      nextBeforeMessageId: forward ? undefined : nextBeforeMessageId,
      nextAfterMessageId: forward ? nextAfterMessageId : undefined,
    };
  }

  /** Посты из ещё живого кэша; для запасного пути, когда Telegram недоступен. */
  private async cachedPage(channel: Channel, options: GuestReadOptions): Promise<GuestPage> {
    const { posts, total } = await this.store.listPosts({
      channelIds: [channel.id],
      includeGuest: true,
      mediaTypes: options.mediaTypes,
      beforeMessageId: options.beforeMessageId,
      afterMessageId: options.afterMessageId,
      order: options.order ?? "newest",
      limit: options.limit,
    });
    return {
      channel,
      posts,
      hasMore: total > posts.length,
      nextBeforeMessageId: posts.length > 0 ? Math.min(...posts.map((post) => post.messageId)) : undefined,
      nextAfterMessageId: options.afterMessageId !== undefined && posts.length > 0
        ? Math.max(...posts.map((post) => post.messageId))
        : undefined,
      fromCache: true,
    };
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

  private historyParams(options: GuestReadOptions, limit: number): HistoryParams {
    if (options.afterMessageId !== undefined) {
      return {
        limit,
        minId: options.afterMessageId,
        maxId: options.beforeMessageId,
        reverse: true,
      };
    }
    return {
      limit,
      offsetId: options.beforeMessageId,
    };
  }

  private async save(channelId: number, messages: readonly MessageLike[]): Promise<void> {
    if (messages.length === 0) return;
    const unique = [...new Map(messages.map((message) => [message.id, message])).values()];
    await this.store.upsertPosts(unique.map((message) => normalizeMessage(channelId, message)));
  }

  private async orderedPosts(channelId: number, messages: readonly MessageLike[], order: "newest" | "oldest"): Promise<Post[]> {
    const ids = [...new Set(messages.map((message) => message.id))];
    const posts = await this.store.getPosts(channelId, ids);
    const byId = new Map(posts.map((post) => [post.messageId, post]));
    return ids
      .map((id) => byId.get(id))
      .filter((post): post is Post => Boolean(post))
      .sort((a, b) => order === "oldest" ? a.messageId - b.messageId : b.messageId - a.messageId);
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
