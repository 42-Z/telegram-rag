/**
 * Инструменты для нейросетей — один раз, для всех способов подключения.
 *
 * Отсюда строятся: MCP-сервер (`/mcp`), REST (`POST /api/tools/<имя>`),
 * описание OpenAPI (`/openapi.json`, для GPT Actions и любых HTTP-агентов)
 * и описания функций в формате function calling (`/api/tools`) — их можно
 * передать напрямую в OpenAI, Gemini, Mistral, Qwen, Llama и любую модель,
 * умеющую вызывать функции.
 */

import { z } from "zod";
import type { Embedder } from "./embeddings.ts";
import { logger } from "./log.ts";
import { postKey, presentPost, presentPostMedia } from "./presentation.ts";
import type { ObjectStorage } from "./storage.ts";
import type { Post, PostFilter, SearchHit, Store } from "./store.ts";
import { SEARCH_EXCLUDED_MEDIA_TYPES, type PostMedia } from "./telegram/normalize.ts";
import type { GuestReader } from "./telegram/reader.ts";

const log = logger("tools");

export interface ToolContext {
  store: Store;
  embedder: Embedder;
  storage?: ObjectStorage;
  mediaTypes?: readonly string[];
  /** Догружает оригинал вложения по явному запросу (до 2048 МиБ). */
  ensureMedia?: (post: Post) => Promise<void>;
  /** Чтение каналов вне пула: Telegram по запросу и временный кэш без индексации. */
  guests?: GuestReader;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  /** По умолчанию инструмент только читает; get_post и list_posts пишут кэш и ходят в Telegram. */
  readOnly?: boolean;
  input: S;
  run(args: z.infer<S>, context: ToolContext): Promise<unknown>;
}

const define = <S extends z.ZodObject>(tool: ToolDef<S>): ToolDef => tool as unknown as ToolDef;

// ── общие части ─────────────────────────────────────────────────────────────

const channelsArg = z
  .array(z.string())
  .optional()
  .describe("Ограничить каналами: @имя, ссылка t.me или id. Не задано — весь пул");
const dateFromArg = z.string().optional().describe("С даты включительно, ISO 8601: 2026-03-01 или 2026-03-01T12:00:00Z");
const dateToArg = z.string().optional().describe("По дату включительно, ISO 8601");
const mediaTypesArg = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe(
    "Только посты с вложениями этих типов: photo, sticker, custom_emoji, document, voice, audio, video, video_note, " +
      "gif, webpage, poll, geo, venue, geo_live, contact, dice, game, invoice, story, giveaway, giveaway_results, " +
      "paid_media, todo, video_stream, unsupported. Можно строкой или массивом",
  );

const mediaTypeAliases: Record<string, string> = {
  image: "photo",
  images: "photo",
  photo: "photo",
  photos: "photo",
  sticker: "sticker",
  stickers: "sticker",
  document: "document",
  documents: "document",
  doc: "document",
  docs: "document",
  voice: "voice",
  voices: "voice",
  audio: "audio",
  audios: "audio",
  music: "audio",
  video: "video",
  videos: "video",
  videonote: "video_note",
  video_note: "video_note",
  round: "video_note",
  gif: "gif",
  gifs: "gif",
  giveaway: "giveaway",
  giveaways: "giveaway",
  "giveaway-results": "giveaway_results",
  giveaway_results: "giveaway_results",
  paid: "paid_media",
  paid_media: "paid_media",
  paidmedia: "paid_media",
};

function normalizeMediaTypes(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  const types = values
    .flatMap((item) => item.split(","))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => mediaTypeAliases[item] ?? item);
  return types.length > 0 ? [...new Set(types)] : undefined;
}

function parseDate(value: string | undefined, endOfDay: boolean): Date | undefined {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly && endOfDay ? `${value}T23:59:59.999Z` : value);
  if (Number.isNaN(date.getTime())) throw new ToolError(`не дата: «${value}»`);
  return date;
}

export class ToolError extends Error {}

async function buildFilter(
  store: Store,
  args: { channels?: string[]; date_from?: string; date_to?: string },
): Promise<PostFilter> {
  const filter: PostFilter = { from: parseDate(args.date_from, false), to: parseDate(args.date_to, true) };
  if (args.channels && args.channels.length > 0) {
    filter.channelIds = [];
    for (const ref of args.channels) {
      const channel = await store.findChannel(ref);
      if (!channel) throw new ToolError(`канала «${ref}» нет в пуле; список — list_channels`);
      if (channel.expiresAt) {
        throw new ToolError(`канал «${ref}» вне пула: поиск и общая лента его не видят — читайте через list_posts`);
      }
      if (!channel.enabled) throw new ToolError(`канал «${ref}» отключён от пула — поиск по нему не работает`);
      filter.channelIds.push(channel.id);
    }
  }
  return filter;
}

const iso = (date: Date | string | null | undefined) => (date ? new Date(date).toISOString() : undefined);
/** Дата без миллисекунд — для ленты постов. */
const isoSeconds = (date: Date | string | null | undefined) =>
  date ? new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined;

/**
 * Альбом в Telegram — несколько сообщений с общим grouped_id, подпись
 * обычно у одного из них. В ленте альбом показывается одним постом.
 */
export function collapseAlbums(posts: readonly Post[]): Array<Post & { album?: Post[] }> {
  const result: Array<Post & { album?: Post[] }> = [];
  const albums = new Map<string, Post & { album?: Post[] }>();
  for (const post of posts) {
    if (!post.groupedId) {
      result.push(post);
      continue;
    }
    const key = `${post.channelId}:${post.groupedId}`;
    const existing = albums.get(key);
    if (!existing) {
      const entry = { ...post, album: [post] };
      albums.set(key, entry);
      result.push(entry);
      continue;
    }
    existing.album!.push(post);
    if (!existing.text && post.text) Object.assign(existing, { ...post, album: existing.album });
  }
  return result;
}

/** Короткое представление вложения: только смысл и тип, без ссылок и служебных полей. */
function compactMedia(media: PostMedia): Record<string, unknown> {
  const view: Record<string, unknown> = { type: media.type };

  switch (media.type) {
    case "voice":
    case "audio":
    case "video":
    case "video_note":
    case "gif":
      if (media.duration !== undefined) view.duration = media.duration;
      if (media.audio?.title || media.audio?.performer) {
        view.audio = {
          ...(media.audio.title ? { title: media.audio.title } : {}),
          ...(media.audio.performer ? { performer: media.audio.performer } : {}),
        };
      }
      break;
    case "document":
      if (media.mimeType) view.mime_type = media.mimeType;
      if (media.size !== undefined) view.size = media.size;
      break;
    case "sticker":
    case "custom_emoji":
      if (media.sticker?.alt || media.sticker?.setName) {
        view.sticker = {
          ...(media.sticker.alt ? { alt: media.sticker.alt } : {}),
          ...(media.sticker.setName ? { setName: media.sticker.setName } : {}),
        };
      }
      break;
    case "webpage":
      if (media.webpage) {
        view.webpage = {
          ...(media.webpage.url ? { url: media.webpage.url } : {}),
          ...(media.webpage.title ? { title: media.webpage.title } : {}),
          ...(media.webpage.description ? { description: media.webpage.description } : {}),
          ...(media.webpage.siteName ? { siteName: media.webpage.siteName } : {}),
        };
      }
      break;
    case "poll":
      if (media.poll) {
        view.poll = {
          question: media.poll.question,
          answers: media.poll.answers,
          ...(media.poll.quiz ? { quiz: true } : {}),
          ...(media.poll.closed ? { closed: true } : {}),
        };
      }
      break;
    case "geo":
    case "venue":
    case "geo_live":
      if (media.geo) {
        view.geo = {
          ...(media.geo.lat !== undefined ? { lat: media.geo.lat } : {}),
          ...(media.geo.long !== undefined ? { long: media.geo.long } : {}),
          ...(media.geo.title ? { title: media.geo.title } : {}),
          ...(media.geo.address ? { address: media.geo.address } : {}),
        };
      }
      break;
    case "contact":
      if (media.contact) {
        view.contact = {
          ...(media.contact.firstName ? { firstName: media.contact.firstName } : {}),
          ...(media.contact.lastName ? { lastName: media.contact.lastName } : {}),
          ...(media.contact.phoneNumber ? { phoneNumber: media.contact.phoneNumber } : {}),
        };
      }
      break;
    case "dice":
      if (media.dice) {
        view.dice = {
          ...(media.dice.value !== undefined ? { value: media.dice.value } : {}),
          ...(media.dice.emoticon ? { emoticon: media.dice.emoticon } : {}),
        };
      }
      break;
    case "game":
      if (media.game) {
        view.game = {
          ...(media.game.title ? { title: media.game.title } : {}),
          ...(media.game.description ? { description: media.game.description } : {}),
        };
      }
      break;
    case "invoice":
      if (media.invoice) {
        view.invoice = {
          ...(media.invoice.title ? { title: media.invoice.title } : {}),
          ...(media.invoice.description ? { description: media.invoice.description } : {}),
          ...(media.invoice.currency ? { currency: media.invoice.currency } : {}),
          ...(media.invoice.totalAmount !== undefined ? { totalAmount: media.invoice.totalAmount } : {}),
        };
      }
      break;
    case "story":
      if (media.story) {
        view.story = {
          ...(media.story.id !== undefined ? { id: media.story.id } : {}),
          ...(media.story.caption ? { caption: media.story.caption } : {}),
          ...(media.story.mediaType ? { mediaType: media.story.mediaType } : {}),
        };
      }
      break;
    case "giveaway":
      if (media.giveaway) {
        view.giveaway = {
          ...(media.giveaway.quantity !== undefined ? { quantity: media.giveaway.quantity } : {}),
          ...(media.giveaway.months !== undefined ? { months: media.giveaway.months } : {}),
          ...(media.giveaway.stars !== undefined ? { stars: media.giveaway.stars } : {}),
          ...(media.giveaway.prizeDescription ? { prizeDescription: media.giveaway.prizeDescription } : {}),
          ...(media.giveaway.channels && media.giveaway.channels.length > 0 ? { channels: media.giveaway.channels } : {}),
          ...(media.giveaway.untilDate !== undefined ? { untilDate: media.giveaway.untilDate } : {}),
        };
      }
      break;
    case "giveaway_results":
      if (media.giveawayResults) {
        view.giveawayResults = {
          ...(media.giveawayResults.winnersCount !== undefined ? { winnersCount: media.giveawayResults.winnersCount } : {}),
          ...(media.giveawayResults.unclaimedCount !== undefined ? { unclaimedCount: media.giveawayResults.unclaimedCount } : {}),
          ...(media.giveawayResults.prizeDescription ? { prizeDescription: media.giveawayResults.prizeDescription } : {}),
          ...(media.giveawayResults.winners && media.giveawayResults.winners.length > 0 ? { winners: media.giveawayResults.winners } : {}),
        };
      }
      break;
    case "paid_media": {
      const items = media.paidMedia?.items ?? [];
      view.paidMedia = {
        ...(media.paidMedia?.starsAmount !== undefined ? { starsAmount: media.paidMedia.starsAmount } : {}),
        ...(items.length > 0
          ? {
              items: items.map((item) => ({
                ...(item.preview ? { preview: true } : {}),
                ...(typeof item.type === "string" ? { type: item.type } : {}),
                ...(typeof item.duration === "number" ? { duration: item.duration } : {}),
              })),
            }
          : {}),
      };
      break;
    }
    case "todo":
      if (media.todo) {
        view.todo = {
          ...(media.todo.title ? { title: media.todo.title } : {}),
          ...(media.todo.items && media.todo.items.length > 0
            ? { items: media.todo.items.map((item) => item.title) }
            : {}),
        };
      }
      break;
    default:
      break;
  }

  return view;
}

/** Короткий пост для ленты: без просмотров, реакций и служебных полей медиа. */
function compactPost(post: Post): Record<string, unknown> {
  const view: Record<string, unknown> = {
    message_id: post.messageId,
    link: post.link,
    date: isoSeconds(post.date),
  };
  if (post.text) view.text = post.text;
  if (post.postAuthor) view.author = post.postAuthor;
  if (post.editDate) view.edited = isoSeconds(post.editDate);
  if (post.media) view.media = compactMedia(post.media);
  return view;
}

function compactAlbumAware(post: Post & { album?: Post[] }): Record<string, unknown> {
  const view = compactPost(post);
  if (!post.album || post.album.length < 2) return view;
  const items = [...post.album].sort((a, b) => a.messageId - b.messageId);
  return { ...view, album: items.map((item) => compactPost(item)) };
}

/** Лента постов с альбомами — без запросов к S3: ссылки на оригиналы отдаёт get_post. */
async function presentFeed(
  posts: readonly Post[],
  store: Pick<Store, "getAlbum">,
) {
  const albums = new Map<string, Post[]>();
  for (const post of posts) {
    if (post.groupedId) {
      const key = `${post.channelId}:${post.groupedId}`;
      if (!albums.has(key)) albums.set(key, await store.getAlbum(post.channelId, post.groupedId));
    }
  }
  const expanded = posts.flatMap((post) => post.groupedId ? albums.get(`${post.channelId}:${post.groupedId}`) ?? [post] : [post]);
  const unique = [...new Map(expanded.map((post) => [postKey(post), post])).values()];
  const collapsed = collapseAlbums(unique);
  const allPosts = collapsed.flatMap((post) => post.album ?? [post]);
  return {
    posts: collapsed.map((post) => compactAlbumAware(post)),
    minMessageId: allPosts.length > 0 ? Math.min(...allPosts.map((post) => post.messageId)) : undefined,
    maxMessageId: allPosts.length > 0 ? Math.max(...allPosts.map((post) => post.messageId)) : undefined,
  };
}

/** Сколько сообщений просматривать в поисках нужного типа, чтобы не зависнуть. */
const MEDIA_SCAN_LIMIT = 500;
const MEDIA_SCAN_BATCH = 100;

/** Посты канала из базы; фильтр по типу вложения просматривает несколько страниц. */
async function collectChannelPosts(
  store: Pick<Store, "listPosts">,
  channelId: number,
  options: {
    limit: number;
    beforeMessageId?: number;
    afterMessageId?: number;
    mediaTypes?: readonly string[];
  },
): Promise<{ posts: Post[]; nextBeforeMessageId?: number; nextAfterMessageId?: number }> {
  if (!options.mediaTypes || options.mediaTypes.length === 0) {
    const { posts } = await store.listPosts({
      channelIds: [channelId],
      beforeMessageId: options.beforeMessageId,
      afterMessageId: options.afterMessageId,
      order: "newest",
      limit: options.limit,
    });
    return {
      posts,
      nextBeforeMessageId: posts.length > 0 ? Math.min(...posts.map((post) => post.messageId)) : undefined,
      nextAfterMessageId: options.afterMessageId !== undefined && posts.length > 0
        ? Math.max(...posts.map((post) => post.messageId))
        : undefined,
    };
  }

  const forward = options.afterMessageId !== undefined;
  let before = options.beforeMessageId;
  let after = options.afterMessageId;
  let nextBeforeMessageId: number | undefined;
  let nextAfterMessageId: number | undefined;
  const matches: Post[] = [];
  let scanned = 0;

  while (scanned < MEDIA_SCAN_LIMIT && matches.length < options.limit) {
    const { posts } = await store.listPosts({
      channelIds: [channelId],
      beforeMessageId: before,
      afterMessageId: after,
      order: forward ? "oldest" : "newest",
      limit: MEDIA_SCAN_BATCH,
    });
    if (posts.length === 0) break;
    scanned += posts.length;
    for (const post of posts) {
      if (post.media && options.mediaTypes.includes(post.media.type)) matches.push(post);
    }
    if (forward) {
      nextAfterMessageId = Math.max(...posts.map((post) => post.messageId));
      after = nextAfterMessageId;
    } else {
      nextBeforeMessageId = Math.min(...posts.map((post) => post.messageId));
      before = nextBeforeMessageId;
    }
    if (posts.length < MEDIA_SCAN_BATCH) break;
  }

  const limited = matches.sort((a, b) => b.messageId - a.messageId).slice(0, options.limit);
  if (matches.length > options.limit) {
    if (forward) nextAfterMessageId = limited[limited.length - 1]!.messageId;
    else nextBeforeMessageId = limited[limited.length - 1]!.messageId;
  }

  return {
    posts: limited,
    nextBeforeMessageId,
    nextAfterMessageId: forward ? nextAfterMessageId : undefined,
  };
}

/** Ошибки Telegram для канала вне пула — понятный отказ инструмента, а не 500. */
async function guestCall<T>(ref: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`канал «${ref}» не прочитан: ${message}`);
  }
}

/** Слияние выдач по рангу (Reciprocal Rank Fusion): смысл и слова на равных. */
export function fuseRankings(lists: ReadonlyArray<readonly SearchHit[]>, limit: number, k = 60): SearchHit[] {
  const merged = new Map<string, SearchHit & { fused: number }>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const key = `${hit.post.channelId}:${hit.post.messageId}`;
      const entry = merged.get(key) ?? { ...hit, fused: 0 };
      entry.fused += 1 / (k + rank + 1);
      entry.matched ??= hit.matched;
      entry.match ??= hit.match;
      merged.set(key, entry);
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.fused - a.fused)
    .slice(0, limit)
    .map(({ fused, ...hit }) => ({ ...hit, score: Number(fused.toFixed(5)) }));
}

// ── инструменты ─────────────────────────────────────────────────────────────

export const TOOLS: ToolDef[] = [
  define({
    name: "list_channels",
    title: "Каналы пула",
    description:
      "Список Telegram-каналов, за которыми следит сервис: название, @имя, описание, сколько постов сохранено и " +
      "проиндексировано, дата первого и последнего поста. Начни с этого, чтобы понять, какие знания доступны. " +
      "Каналы вне пула здесь не перечисляются — их посты читает list_posts.",
    input: z.object({}),
    async run(_args, { store, mediaTypes }) {
      const channels = await store.channelStats(mediaTypes ?? []);
      return {
        channels: channels.map((channel) => ({
          id: channel.id,
          title: channel.title,
          username: channel.username ?? undefined,
          link: channel.username ? `https://t.me/${channel.username}` : undefined,
          about: channel.about ?? undefined,
          posts: channel.posts,
          indexed: channel.indexed,
          history_loaded: channel.backfillDone,
          first_post: iso(channel.firstPost),
          last_post: iso(channel.lastPost),
          last_sync: iso(channel.syncedAt),
        })),
      };
    },
  }),

  define({
    name: "search_posts",
    title: "Поиск по постам",
    description:
      "Поиск по исходному тексту, изображениям, аудио и видео через прямые эмбеддинги. Возвращает текст поста, " +
      "метаданные вложений, прямые временные ссылки на сохранённые оригиналы и ссылки на Telegram-посты. " +
      "Формулируй запрос обычными словами — синонимы и перефразы находятся. Для точных " +
      "имён, чисел и терминов можно mode=keyword, для абстрактных тем — mode=semantic.",
    input: z.object({
      query: z.string().min(1).describe("Что ищем, обычными словами"),
      channels: channelsArg,
      date_from: dateFromArg,
      date_to: dateToArg,
      limit: z.number().int().min(1).max(50).optional().describe("Сколько постов вернуть, по умолчанию 10"),
      mode: z
        .enum(["hybrid", "semantic", "keyword"])
        .optional()
        .describe("hybrid (по умолчанию) — смысл + слова; semantic — только смысл; keyword — только слова"),
    }),
    async run(args, { store, embedder, storage }) {
      const limit = args.limit ?? 10;
      const filter = await buildFilter(store, args);
      // Стикеры, раздачи и платные медиа видны в ленте, но не в поиске.
      filter.excludeMediaTypes = SEARCH_EXCLUDED_MEDIA_TYPES;
      let mode = args.mode ?? "hybrid";
      let notice: string | undefined;

      let semantic: SearchHit[] = [];
      if (mode !== "keyword") {
        try {
          const [vector] = await embedder.embed([{ type: "text", purpose: "query", text: args.query }]);
          semantic = await store.semanticSearch(vector!, filter, mode === "hybrid" ? limit * 2 : limit);
        } catch (error) {
          log.warn("поиск по смыслу не удался", error);
          notice = "поиск по смыслу временно недоступен — результат только по словам";
          mode = "keyword";
        }
      }
      const keyword = mode !== "semantic" ? await store.keywordSearch(args.query, filter, mode === "hybrid" ? limit * 2 : limit) : [];
      const hits = mode === "hybrid" ? fuseRankings([semantic, keyword], limit) : (mode === "semantic" ? semantic : keyword).slice(0, limit);

      const albums = new Map<string, Post[]>();
      for (const hit of hits) {
        const post = hit.post;
        const key = post.groupedId ? `${post.channelId}:${post.groupedId}` : undefined;
        if (key && !albums.has(key)) albums.set(key, await store.getAlbum(post.channelId, post.groupedId!));
      }
      const related = [...hits.map((hit) => hit.post), ...[...albums.values()].flat()];
      const media = await presentPostMedia(related, store, storage);
      return {
        query: args.query,
        mode,
        notice,
        results: hits.map((hit) => {
          const match = hit.match && hit.match.kind !== "text"
            ? {
                kind: hit.match.kind,
                message_id: hit.post.messageId,
                start_seconds: hit.match.startSeconds ?? undefined,
                end_seconds: hit.match.endSeconds ?? undefined,
              }
            : undefined;
          const album = hit.post.groupedId
            ? albums.get(`${hit.post.channelId}:${hit.post.groupedId}`)
            : undefined;
          return presentPost(hit.post, media.get(postKey(hit.post)), {
            score: Number(hit.score.toFixed(4)),
            match,
            ...(album && album.length > 1
              ? { album: album.map((item) => presentPost(item, media.get(postKey(item)))) }
              : {}),
          });
        }),
      };
    },
  }),

  define({
    name: "get_post",
    title: "Пост целиком",
    description:
      "Один пост полностью по ссылке t.me/<канал>/<id> или по каналу и номеру сообщения: исходный текст, прямые " +
      "ссылки на сохранённые вложения, все части альбома, пост, на который он отвечает, и соседние посты канала. " +
      "Недостающие оригиналы каналов пула догружает из Telegram; у каналов вне пула вложения не сохраняются.",
    readOnly: false,
    input: z.object({
      link: z.string().optional().describe("Ссылка вида https://t.me/<канал>/<id> или https://t.me/c/<id>/<id>"),
      channel: z.string().optional().describe("@имя, ссылка или id канала — если нет ссылки"),
      message_id: z.number().int().optional().describe("Номер сообщения в канале — если нет ссылки"),
      context: z.number().int().min(0).max(10).optional().describe("Сколько соседних постов до и после добавить, по умолчанию 0"),
    }),
    async run(args, { store, storage, ensureMedia, guests }) {
      let channelRef = args.channel;
      let messageId = args.message_id;
      if (args.link) {
        const match = args.link.match(/t(?:elegram)?\.me\/(?:s\/)?(?:c\/)?([\w]+)\/(\d+)/i);
        if (!match) throw new ToolError(`не ссылка на пост: «${args.link}»`);
        channelRef = match[1];
        messageId = Number(match[2]);
      }
      if (!channelRef || !messageId) throw new ToolError("нужна ссылка или пара channel + message_id");
      const channel = await store.findChannel(channelRef);

      if (channel?.expiresAt && !channel.enabled) {
        throw new ToolError(`канал «${channelRef}» отключён: включите его в управлении или читайте другой публичный канал`);
      }

      // Канал пула (в том числе отключённый): посты уже в базе, доступен архив вложений.
      if (channel && !channel.expiresAt) {
        const post = await store.getPost(channel.id, messageId);
        if (!post) throw new ToolError(`поста ${messageId} в канале «${channel.title}» нет в базе`);

        const album = post.groupedId ? await store.getAlbum(channel.id, post.groupedId) : [];
        const replyTo = post.replyTo ? await store.getPost(channel.id, post.replyTo) : undefined;
        let before: Post[] = [];
        let after: Post[] = [];
        if (args.context) {
          const around = async (order: "newest" | "oldest", bound: { from?: Date; to?: Date }) =>
            (await store.listPosts({ channelIds: [channel.id], ...bound, order, limit: args.context! + album.length + 1 })).posts
              .filter((item) => item.messageId !== post.messageId && !(post.groupedId && item.groupedId === post.groupedId))
              .slice(0, args.context);
          before = (await around("newest", { to: new Date(post.date) })).reverse();
          after = await around("oldest", { from: new Date(post.date) });
        }
        // Прямой запрос по ссылке догружает оригиналы самого поста и альбома,
        // не дожидаясь очереди; соседние посты остаются как есть.
        if (ensureMedia) {
          const requested = new Map([post, ...album].map((item) => [postKey(item), item]));
          for (const item of requested.values()) await ensureMedia(item);
        }

        const allPosts = [post, ...album, ...(replyTo ? [replyTo] : []), ...before, ...after];
        const media = await presentPostMedia(allPosts, store, storage);
        const extra: Record<string, unknown> = {};
        if (album.length > 1) {
          extra.album = album.map((item) => presentPost(item, media.get(postKey(item))));
          if (!post.text) extra.text = album.find((item) => item.text)?.text ?? "";
        }
        if (replyTo) extra.reply_to = presentPost(replyTo, media.get(postKey(replyTo)));
        if (before.length > 0) extra.before = before.map((item) => presentPost(item, media.get(postKey(item))));
        if (after.length > 0) extra.after = after.map((item) => presentPost(item, media.get(postKey(item))));
        return presentPost(post, media.get(postKey(post)), extra);
      }

      // Канал вне пула: тянем из Telegram в кэш, вложения не архивируем.
      if (!guests) {
        throw new ToolError(`канала «${channelRef}» нет в пуле, а Telegram не подключён: пост недоступен`);
      }
      const result = await guestCall(channelRef, () =>
        guests.getPost(channelRef, messageId, { context: args.context }),
      );
      if (!result) throw new ToolError(`поста ${messageId} в канале «${channelRef}» нет`);

      const allPosts = [result.post, ...result.album, ...(result.replyTo ? [result.replyTo] : []), ...result.before, ...result.after];
      const media = await presentPostMedia(allPosts, store, storage, { archived: false });
      const extra: Record<string, unknown> = {
        outside_pool: true,
        searchable: false,
        source: result.fromCache ? "cache" : "telegram",
        cache_expires_at: iso(result.channel.expiresAt),
      };
      if (result.album.length > 1) {
        extra.album = result.album.map((item) => presentPost(item, media.get(postKey(item))));
        if (!result.post.text) extra.text = result.album.find((item) => item.text)?.text ?? "";
      }
      if (result.replyTo) extra.reply_to = presentPost(result.replyTo, media.get(postKey(result.replyTo)));
      if (result.before.length > 0) extra.before = result.before.map((item) => presentPost(item, media.get(postKey(item))));
      if (result.after.length > 0) extra.after = result.after.map((item) => presentPost(item, media.get(postKey(item))));
      return presentPost(result.post, media.get(postKey(result.post)), extra);
    },
  }),

  define({
    name: "list_posts",
    title: "Посты канала",
    description:
      "Короткая лента одного канала по @имени, ссылке t.me/<имя> или id — от новых к старым. Работает и для " +
      "каналов вне пула. Отдаёт message_id, link, date, text, media и album без просмотров, реакций, комментариев " +
      "и служебных полей вложений; подробности и скачивание — через get_post. " +
      "Перелистывание вглубь — before_message_id, добрать новее — after_message_id. " +
      "media_types оставляет только посты с документами, стикерами или другими указанными вложениями.",
    readOnly: false,
    input: z.object({
      channel: z.string().min(1).describe("@имя, ссылка https://t.me/<имя> или id канала"),
      limit: z.number().int().min(1).max(100).optional().describe("Сколько постов вернуть, по умолчанию 20"),
      before_message_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Только посты старше этого номера — для следующей страницы вглубь"),
      after_message_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Только посты новее этого номера — чтобы добрать новые"),
      media_types: mediaTypesArg,
    }),
    async run(args, { store, guests }) {
      const limit = args.limit ?? 20;
      const mediaTypes = normalizeMediaTypes(args.media_types);
      const channel = await store.findChannel(args.channel);

      if (channel && !channel.enabled) {
        throw new ToolError(`канал «${args.channel}» отключён: включите его в управлении или читайте другой публичный канал`);
      }

      let result: { posts: Post[]; nextBeforeMessageId?: number; nextAfterMessageId?: number };
      if (channel && !channel.expiresAt) {
        result = await collectChannelPosts(store, channel.id, {
          limit,
          beforeMessageId: args.before_message_id,
          afterMessageId: args.after_message_id,
          mediaTypes,
        });
      } else {
        if (!guests) {
          throw new ToolError("Telegram не подключён: каналы вне пула прочитать нельзя, доступны только каналы пула");
        }
        const page = await guestCall(args.channel, () =>
          guests.read(args.channel, {
            limit,
            beforeMessageId: args.before_message_id,
            afterMessageId: args.after_message_id,
            mediaTypes,
          }),
        );
        result = {
          posts: page.posts,
          nextBeforeMessageId: page.nextBeforeMessageId,
          nextAfterMessageId: page.nextAfterMessageId,
        };
      }

      const feed = await presentFeed(result.posts, store);
      return {
        posts: feed.posts,
        next_before_message_id: feed.minMessageId ?? result.nextBeforeMessageId,
        next_after_message_id: args.after_message_id !== undefined
          ? feed.maxMessageId ?? result.nextAfterMessageId
          : undefined,
      };
    },
  }),
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/** Проверка аргументов и запуск — общий для всех способов подключения. */
export async function callTool(name: string, rawArgs: unknown, context: ToolContext): Promise<unknown> {
  const tool = findTool(name);
  if (!tool) throw new ToolError(`нет инструмента «${name}»`);
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new ToolError(`неверные аргументы: ${z.prettifyError(parsed.error)}`);
  return tool.run(parsed.data, context);
}

/** JSON Schema аргументов инструмента — для OpenAPI и function calling. */
export function toolJsonSchema(tool: ToolDef): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input, { target: "draft-2020-12" }) as Record<string, unknown>;
  return schema;
}
