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
import type { Post, PostFilter, SearchHit, Store } from "./store.ts";

const log = logger("tools");

export interface ToolContext {
  store: Store;
  embedder: Embedder | undefined;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
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
      if (!channel || !channel.enabled) throw new ToolError(`канала «${ref}» нет в пуле; список — list_channels`);
      filter.channelIds.push(channel.id);
    }
  }
  return filter;
}

const iso = (date: Date | string | null | undefined) => (date ? new Date(date).toISOString() : undefined);

/** Пост в виде для модели: без пустых полей, с понятными именами. */
export function presentPost(post: Post, extra: Record<string, unknown> = {}) {
  const view = {
    channel: post.channel,
    channel_username: post.channelUsername ?? undefined,
    channel_id: post.channelId,
    message_id: post.messageId,
    link: post.link,
    date: iso(post.date),
    edited: iso(post.editDate),
    author: post.postAuthor ?? undefined,
    text: post.text,
    media: post.media
      ? {
          ...post.media,
          searchText: undefined,
          fileId: undefined,
          // что модель увидела и услышала в медиа — как текст
          transcript: post.mediaAnalysis?.transcript,
          description: post.mediaAnalysis?.description,
          text_on_image: post.mediaAnalysis?.textOnImage,
          analysis: post.mediaStatus === "done" ? undefined : (post.mediaAnalysis?.note ?? post.mediaStatus ?? undefined),
        }
      : undefined,
    views: post.views ?? undefined,
    forwards: post.forwards ?? undefined,
    comments: post.replies ?? undefined,
    reactions: post.reactions ?? undefined,
    reply_to_message_id: post.replyTo ?? undefined,
    forwarded_from: post.forwardedFrom ?? undefined,
    deleted: post.deleted || undefined,
    ...extra,
  };
  return JSON.parse(JSON.stringify(view));
}

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

function presentAlbumAware(post: Post & { album?: Post[] }) {
  if (!post.album || post.album.length < 2) return presentPost(post);
  const items = [...post.album].sort((a, b) => a.messageId - b.messageId);
  return presentPost(post, {
    album: items.map((item) => ({ message_id: item.messageId, link: item.link, media: item.media?.type })),
  });
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
      "проиндексировано, дата первого и последнего поста. Начни с этого, чтобы понять, какие знания доступны.",
    input: z.object({}),
    async run(_args, { store }) {
      const channels = await store.channelStats();
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
      "Поиск постов по смыслу и по словам одновременно (гибридный). Ищет и по тексту, и по содержимому медиа: " +
      "расшифровкам голосовых и кружков, описаниям фото, тексту на картинках. Возвращает посты целиком: текст, медиа, " +
      "дату, ссылку, реакции. Формулируй запрос обычными словами — синонимы и перефразы находятся. Для точных " +
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
    async run(args, { store, embedder }) {
      const limit = args.limit ?? 10;
      const filter = await buildFilter(store, args);
      let mode = args.mode ?? "hybrid";
      let notice: string | undefined;

      let semantic: SearchHit[] = [];
      if (mode !== "keyword") {
        if (!embedder) {
          notice = "сервис эмбеддингов не настроен — поиск только по словам";
          mode = "keyword";
        } else {
          try {
            const [vector] = await embedder.embed([args.query]);
            semantic = await store.semanticSearch(vector!, filter, mode === "hybrid" ? limit * 2 : limit);
          } catch (error) {
            log.warn("поиск по смыслу не удался", error);
            notice = "поиск по смыслу временно недоступен — результат только по словам";
            mode = "keyword";
          }
        }
      }
      const keyword = mode !== "semantic" ? await store.keywordSearch(args.query, filter, mode === "hybrid" ? limit * 2 : limit) : [];
      const hits = mode === "hybrid" ? fuseRankings([semantic, keyword], limit) : (mode === "semantic" ? semantic : keyword).slice(0, limit);

      return {
        query: args.query,
        mode,
        notice,
        results: hits.map((hit) => presentPost(hit.post, { score: Number(hit.score.toFixed(4)) })),
      };
    },
  }),

  define({
    name: "get_post",
    title: "Пост целиком",
    description:
      "Один пост полностью по ссылке t.me/<канал>/<id> или по каналу и номеру сообщения: текст, медиа, все " +
      "части альбома, пост, на который он отвечает, и соседние посты канала для контекста.",
    input: z.object({
      link: z.string().optional().describe("Ссылка вида https://t.me/<канал>/<id> или https://t.me/c/<id>/<id>"),
      channel: z.string().optional().describe("@имя, ссылка или id канала — если нет ссылки"),
      message_id: z.number().int().optional().describe("Номер сообщения в канале — если нет ссылки"),
      context: z.number().int().min(0).max(10).optional().describe("Сколько соседних постов до и после добавить, по умолчанию 0"),
    }),
    async run(args, { store }) {
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
      if (!channel) throw new ToolError(`канала «${channelRef}» нет в пуле`);
      const post = await store.getPost(channel.id, messageId);
      if (!post) throw new ToolError(`поста ${messageId} в канале «${channel.title}» нет в базе`);

      const album = post.groupedId ? await store.getAlbum(channel.id, post.groupedId) : [];
      const replyTo = post.replyTo ? await store.getPost(channel.id, post.replyTo) : undefined;
      const extra: Record<string, unknown> = {};
      if (album.length > 1) {
        extra.album = album.map((item) => presentPost(item));
        if (!post.text) extra.text = album.find((item) => item.text)?.text ?? "";
      }
      if (replyTo) extra.reply_to = presentPost(replyTo);

      if (args.context) {
        const around = async (order: "newest" | "oldest", bound: { from?: Date; to?: Date }) =>
          (await store.listPosts({ channelIds: [channel.id], ...bound, order, limit: args.context! + album.length + 1 })).posts
            .filter((item) => item.messageId !== post.messageId && !(post.groupedId && item.groupedId === post.groupedId))
            .slice(0, args.context);
        const before = await around("newest", { to: new Date(post.date) });
        const after = await around("oldest", { from: new Date(post.date) });
        extra.before = before.reverse().map((item) => presentPost(item));
        extra.after = after.map((item) => presentPost(item));
      }
      return presentPost(post, extra);
    },
  }),

  define({
    name: "list_posts",
    title: "Лента постов",
    description:
      "Посты подряд по времени — как лента канала: за период, по каналам, от новых к старым или наоборот, с " +
      "перелистыванием через offset. Для вопросов «что было на этой неделе», «последние посты», полного " +
      "просмотра архива. Альбомы показаны одним постом.",
    input: z.object({
      channels: channelsArg,
      date_from: dateFromArg,
      date_to: dateToArg,
      order: z.enum(["newest", "oldest"]).optional().describe("newest (по умолчанию) или oldest"),
      limit: z.number().int().min(1).max(100).optional().describe("Сколько постов, по умолчанию 20"),
      offset: z.number().int().min(0).optional().describe("Пропустить столько постов — для следующей страницы"),
    }),
    async run(args, { store }) {
      const limit = args.limit ?? 20;
      const offset = args.offset ?? 0;
      const filter = await buildFilter(store, args);
      const { posts, total } = await store.listPosts({ ...filter, order: args.order ?? "newest", limit, offset });
      return {
        total,
        offset,
        next_offset: offset + posts.length < total ? offset + posts.length : undefined,
        posts: collapseAlbums(posts).map(presentAlbumAware),
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
