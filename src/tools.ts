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
  /** Инструмент обращается к внешнему миру — Telegram. */
  openWorld?: boolean;
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

const MEDIA_TYPE_ALIASES: Record<string, string> = {
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

const KNOWN_MEDIA_TYPES = new Set([
  "photo",
  "sticker",
  "custom_emoji",
  "document",
  "voice",
  "audio",
  "video",
  "video_note",
  "gif",
  "webpage",
  "poll",
  "geo",
  "venue",
  "geo_live",
  "contact",
  "dice",
  "game",
  "invoice",
  "story",
  "giveaway",
  "giveaway_results",
  "paid_media",
  "todo",
  "video_stream",
  "unsupported",
]);

function normalizeMediaTypes(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  const types = values
    .flatMap((item) => item.split(","))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => MEDIA_TYPE_ALIASES[item] ?? item);
  const unknown = [...new Set(types)].filter((type) => !KNOWN_MEDIA_TYPES.has(type));
  if (unknown.length > 0) {
    throw new ToolError(`неизвестные типы вложений: ${unknown.join(", ")}; допустимы: ${[...KNOWN_MEDIA_TYPES].join(", ")}`);
  }
  return types.length > 0 ? [...new Set(types)] : undefined;
}

function parseDate(value: string | undefined, endOfDay: boolean): Date | undefined {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new ToolError(`не дата: «${value}»`);
  const normalized = dateOnly
    ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    : /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new ToolError(`не дата: «${value}»`);
  return date;
}

export class ToolError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

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
          ...(media.sticker.setName ? { set_name: media.sticker.setName } : {}),
        };
      }
      break;
    case "webpage":
      if (media.webpage) {
        view.webpage = {
          ...(media.webpage.url ? { url: media.webpage.url } : {}),
          ...(media.webpage.title ? { title: media.webpage.title } : {}),
          ...(media.webpage.description ? { description: media.webpage.description } : {}),
          ...(media.webpage.siteName ? { site_name: media.webpage.siteName } : {}),
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
          ...(media.contact.firstName ? { first_name: media.contact.firstName } : {}),
          ...(media.contact.lastName ? { last_name: media.contact.lastName } : {}),
          ...(media.contact.phoneNumber ? { phone_number: media.contact.phoneNumber } : {}),
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
          ...(media.invoice.totalAmount !== undefined ? { total_amount: media.invoice.totalAmount } : {}),
        };
      }
      break;
    case "story":
      if (media.story) {
        view.story = {
          ...(media.story.id !== undefined ? { id: media.story.id } : {}),
          ...(media.story.caption ? { caption: media.story.caption } : {}),
          ...(media.story.mediaType ? { media_type: media.story.mediaType } : {}),
        };
      }
      break;
    case "giveaway":
      if (media.giveaway) {
        view.giveaway = {
          ...(media.giveaway.quantity !== undefined ? { quantity: media.giveaway.quantity } : {}),
          ...(media.giveaway.months !== undefined ? { months: media.giveaway.months } : {}),
          ...(media.giveaway.stars !== undefined ? { stars: media.giveaway.stars } : {}),
          ...(media.giveaway.prizeDescription ? { prize_description: media.giveaway.prizeDescription } : {}),
          ...(media.giveaway.channels && media.giveaway.channels.length > 0 ? { channels: media.giveaway.channels } : {}),
          ...(media.giveaway.untilDate !== undefined ? { until_date: media.giveaway.untilDate } : {}),
        };
      }
      break;
    case "giveaway_results":
      if (media.giveawayResults) {
        view.giveaway_results = {
          ...(media.giveawayResults.winnersCount !== undefined ? { winners_count: media.giveawayResults.winnersCount } : {}),
          ...(media.giveawayResults.unclaimedCount !== undefined ? { unclaimed_count: media.giveawayResults.unclaimedCount } : {}),
          ...(media.giveawayResults.prizeDescription ? { prize_description: media.giveawayResults.prizeDescription } : {}),
          ...(media.giveawayResults.winners && media.giveawayResults.winners.length > 0 ? { winners: media.giveawayResults.winners } : {}),
        };
      }
      break;
    case "paid_media": {
      const items = media.paidMedia?.items ?? [];
      view.paid_media = {
        ...(media.paidMedia?.starsAmount !== undefined ? { stars_amount: media.paidMedia.starsAmount } : {}),
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
  return {
    posts: collapsed.map((post) => compactAlbumAware(post)),
  };
}

/** Посты канала из базы; offset считается по постам после свёртки альбомов. */
async function collectDisplayedPosts(
  store: Pick<Store, "listPosts" | "getAlbum" | "countPosts">,
  channelId: number,
  options: {
    includeGuest: boolean;
    from?: Date;
    to?: Date;
    mediaTypes?: readonly string[];
    offset: number;
    limit: number;
  },
): Promise<{ posts: Post[]; returned: number; exhausted: boolean }> {
  const filter = {
    channelIds: [channelId],
    includeGuest: options.includeGuest,
    from: options.from,
    to: options.to,
    mediaTypes: options.mediaTypes,
  };
  const total = await store.countPosts(filter);
  const target = options.offset + options.limit;
  const seenAlbums = new Set<string>();
  const selected: Post[] = [];
  let displayed = 0;
  let returned = 0;
  let rawOffset = 0;
  let exhausted = false;

  while (displayed < target) {
    const page = await store.listPosts({
      ...filter,
      order: "newest",
      limit: 100,
      offset: rawOffset,
      count: false,
    });
    if (page.posts.length === 0) {
      exhausted = true;
      break;
    }
    rawOffset += page.posts.length;

    for (const post of page.posts) {
      const willSelect = displayed + 1 > options.offset && returned < options.limit;
      let entry: Post[];
      if (post.groupedId) {
        const key = `${post.channelId}:${post.groupedId}`;
        if (seenAlbums.has(key)) continue;
        seenAlbums.add(key);
        entry = willSelect ? await store.getAlbum(post.channelId, post.groupedId) : [post];
        if (entry.length === 0) entry = [post];
      } else {
        entry = [post];
      }

      displayed += 1;
      if (willSelect) {
        selected.push(...entry);
        returned += 1;
      }
    }
    if (page.posts.length < 100) {
      exhausted = displayed <= target;
      break;
    }
  }

  if (rawOffset >= total) exhausted = displayed <= target;
  return { posts: selected, returned, exhausted };
}

/** Ошибки Telegram для канала вне пула — понятный отказ инструмента, а не 500. */
async function guestCall<T>(ref: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const transient = /FLOOD_WAIT|FloodWait|flood wait|wait of \d+ seconds|TIMEOUT|ECONN|ENET|EHOST|socket|connection|не удалось подключиться/i.test(
      message,
    );
    throw new ToolError(`канал «${ref}» не прочитан: ${message}`, transient ? 503 : 400);
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
    openWorld: true,
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
      "date_from и date_to включают границы, offset пропускает посты для следующей страницы, " +
      "media_types оставляет только посты с документами, стикерами или другими указанными вложениями. " +
      "На живой ленте фиксируйте date_to на время обхода, иначе новые посты сдвинут offset.",
    readOnly: false,
    openWorld: true,
    input: z.object({
      channel: z.string().min(1).describe("@имя, ссылка https://t.me/<имя> или id канала"),
      date_from: dateFromArg,
      date_to: dateToArg,
      limit: z.number().int().min(1).max(100).optional().describe("Сколько постов вернуть, по умолчанию 20"),
      offset: z.number().int().min(0).optional().describe("Пропустить столько постов — для следующей страницы"),
      media_types: mediaTypesArg,
    }),
    async run(args, { store, guests }) {
      const limit = args.limit ?? 20;
      const offset = args.offset ?? 0;
      const from = parseDate(args.date_from, false);
      const to = parseDate(args.date_to, true);
      const mediaTypes = normalizeMediaTypes(args.media_types);
      const channel = await store.findChannel(args.channel);

      if (channel && !channel.enabled) {
        throw new ToolError(`канал «${args.channel}» отключён: включите его в управлении или читайте другой публичный канал`);
      }

      let channelId: number;
      let includeGuest = false;
      let complete = true;
      let notice: string | undefined;
      let page: { posts: Post[]; returned: number; exhausted: boolean };

      if (channel && !channel.expiresAt) {
        channelId = channel.id;
        page = await collectDisplayedPosts(store, channelId, {
          includeGuest: false,
          from,
          to,
          mediaTypes,
          offset,
          limit,
        });
      } else {
        if (!guests) {
          throw new ToolError("Telegram не подключён: каналы вне пула прочитать нельзя, доступны только каналы пула");
        }
        includeGuest = true;
        channelId = 0;
        page = { posts: [], returned: 0, exhausted: false };
        let needed = offset + limit;
        while (true) {
          const ensured = await guestCall(args.channel, () =>
            guests.ensurePosts(args.channel, {
              needed,
              dateFrom: from,
              dateTo: to,
              mediaTypes,
            }),
          );
          channelId = ensured.channel.id;
          complete = ensured.complete;
          notice = ensured.notice;
          page = await collectDisplayedPosts(store, channelId, {
            includeGuest,
            from,
            to,
            mediaTypes,
            offset,
            limit,
          });
          if (page.returned >= limit || ensured.complete || ensured.notice) break;
          needed *= 2;
        }
      }

      const feed = await presentFeed(page.posts, store);
      return {
        posts: feed.posts,
        next_offset: page.returned >= limit && !(complete && page.exhausted)
          ? offset + page.returned
          : undefined,
        ...(notice ? { notice } : {}),
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
