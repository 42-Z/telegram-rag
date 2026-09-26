/**
 * Хранилище: каналы пула, посты целиком, куски с векторами и поиск по ним.
 */

import type { Db } from "./db.ts";
import type { PostMedia, PostRecord } from "./telegram/normalize.ts";
import { postLink, searchableText } from "./telegram/normalize.ts";

export interface Channel {
  id: number;
  ref: string;
  username: string | null;
  title: string;
  about: string | null;
  accessHash: string | null;
  enabled: boolean;
  lastMessageId: number;
  backfillDone: boolean;
  addedAt: Date;
  syncedAt: Date | null;
}

export interface Post {
  channelId: number;
  channel: string;
  channelUsername: string | null;
  messageId: number;
  link: string;
  date: Date;
  editDate: Date | null;
  text: string;
  media: PostMedia | null;
  groupedId: string | null;
  views: number | null;
  forwards: number | null;
  replies: number | null;
  reactions: Array<{ reaction: string; count: number }> | null;
  replyTo: number | null;
  forwardedFrom: PostRecord["forwardedFrom"];
  postAuthor: string | null;
  deleted: boolean;
  mediaStatus: MediaStatus | null;
  mediaAnalysis: MediaAnalysis | null;
}

export type MediaStatus = "done" | "skipped" | "failed";

/** Что удалось достать из медиа: расшифровка, описание, текст на изображении. */
export interface MediaAnalysis {
  transcript?: string;
  description?: string;
  textOnImage?: string;
  /** Почему не разобрано: слишком большое, длинное, нет звука… */
  note?: string;
  model?: string;
}

export interface MediaJob {
  channelId: number;
  messageId: number;
  date: Date;
  text: string;
  media: PostMedia;
}

export interface PostFilter {
  /** Идентификаторы каналов; пусто — весь пул. */
  channelIds?: number[];
  from?: Date;
  to?: Date;
}

export interface SearchHit {
  post: Post;
  score: number;
  /** Кусок поста, совпавший с запросом по смыслу. */
  matched?: string;
}

const channelColumns = (t = "") =>
  `${t}id, ${t}ref, ${t}username, ${t}title, ${t}about, ${t}access_hash AS "accessHash", ${t}enabled,
  ${t}last_message_id AS "lastMessageId", ${t}backfill_done AS "backfillDone", ${t}added_at AS "addedAt",
  ${t}synced_at AS "syncedAt"`;
const CHANNEL_COLUMNS = channelColumns();

const POST_COLUMNS = `p.channel_id AS "channelId", c.title AS channel, c.username AS "channelUsername",
  p.message_id AS "messageId", p.date, p.edit_date AS "editDate", p.text, p.media, p.grouped_id AS "groupedId",
  p.views, p.forwards, p.replies, p.reactions, p.reply_to AS "replyTo", p.forwarded_from AS "forwardedFrom",
  p.post_author AS "postAuthor", p.deleted, p.media_status AS "mediaStatus", p.media_analysis AS "mediaAnalysis"`;

type PostRow = Omit<Post, "link">;

const withLink = (row: PostRow): Post => ({
  ...row,
  link: postLink({ id: row.channelId, username: row.channelUsername }, row.messageId),
});

/** Условия фильтра, начиная с параметра `$<offset+1>`. */
function filterSql(filter: PostFilter, params: unknown[]): string {
  const where = ["NOT p.deleted", "c.enabled"];
  if (filter.channelIds && filter.channelIds.length > 0) {
    params.push(filter.channelIds);
    where.push(`p.channel_id = ANY($${params.length}::bigint[])`);
  }
  if (filter.from) {
    params.push(filter.from);
    where.push(`p.date >= $${params.length}`);
  }
  if (filter.to) {
    params.push(filter.to);
    where.push(`p.date <= $${params.length}`);
  }
  return where.join(" AND ");
}

export const toVector = (values: readonly number[]): string => `[${values.join(",")}]`;

export class Store {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ── каналы ──────────────────────────────────────────────────────────────

  async upsertChannel(channel: {
    id: number;
    ref: string;
    username: string | null;
    title: string;
    about: string | null;
    accessHash: string | null;
  }): Promise<Channel> {
    const [row] = await this.db.query<Channel>(
      `INSERT INTO channels (id, ref, username, title, about, access_hash, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (id) DO UPDATE SET
         ref = EXCLUDED.ref, username = EXCLUDED.username, title = EXCLUDED.title,
         about = COALESCE(EXCLUDED.about, channels.about),
         access_hash = COALESCE(EXCLUDED.access_hash, channels.access_hash),
         enabled = true
       RETURNING ${CHANNEL_COLUMNS}`,
      [channel.id, channel.ref, channel.username, channel.title, channel.about, channel.accessHash],
    );
    return row!;
  }

  async listChannels(options: { includeDisabled?: boolean } = {}): Promise<Channel[]> {
    return this.db.query<Channel>(
      `SELECT ${CHANNEL_COLUMNS} FROM channels ${options.includeDisabled ? "" : "WHERE enabled"} ORDER BY added_at`,
    );
  }

  async channelStats(): Promise<Array<Channel & { posts: number; indexed: number; firstPost: Date | null; lastPost: Date | null }>> {
    return this.db.query(
      `SELECT ${channelColumns("c.")},
         count(p.message_id) FILTER (WHERE NOT p.deleted)::int AS posts,
         count(p.message_id) FILTER (WHERE NOT p.deleted AND p.embedded_hash = p.index_hash)::int AS indexed,
         min(p.date) FILTER (WHERE NOT p.deleted) AS "firstPost",
         max(p.date) FILTER (WHERE NOT p.deleted) AS "lastPost"
       FROM channels c LEFT JOIN posts p ON p.channel_id = c.id
       WHERE c.enabled
       GROUP BY c.id ORDER BY c.added_at`,
    );
  }

  /** Канал по @имени, ссылке, id или исходной записи, с которой его добавили. */
  async findChannel(ref: string | number): Promise<Channel | undefined> {
    const value = String(ref).trim();
    const username = value
      .replace(/^https?:\/\/(t|telegram)\.me\//i, "")
      .replace(/^@/, "")
      .split(/[/?]/)[0]!;
    const id = /^-?\d+$/.test(value) ? Number(value.replace(/^-100/, "")) : null;
    const [row] = await this.db.query<Channel>(
      `SELECT ${CHANNEL_COLUMNS} FROM channels
       WHERE id = $1 OR lower(username) = lower($2) OR ref = $3 LIMIT 1`,
      [id ?? -1, username, value],
    );
    return row;
  }

  async disableChannel(id: number, purge: boolean): Promise<void> {
    if (purge) await this.db.query("DELETE FROM channels WHERE id = $1", [id]);
    else await this.db.query("UPDATE channels SET enabled = false WHERE id = $1", [id]);
  }

  async markSynced(id: number, fields: { lastMessageId?: number; backfillDone?: boolean }): Promise<void> {
    await this.db.query(
      `UPDATE channels SET
         last_message_id = GREATEST(last_message_id, COALESCE($2, 0)),
         backfill_done = COALESCE($3, backfill_done),
         synced_at = now()
       WHERE id = $1`,
      [id, fields.lastMessageId ?? null, fields.backfillDone ?? null],
    );
  }

  // ── посты ───────────────────────────────────────────────────────────────

  async upsertPosts(posts: readonly PostRecord[]): Promise<void> {
    for (const post of posts) {
      await this.db.query(
        `INSERT INTO posts (channel_id, message_id, date, edit_date, text, media, grouped_id, views, forwards,
           replies, reactions, reply_to, forwarded_from, post_author, content_hash, deleted, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14, $15, false, now())
         ON CONFLICT (channel_id, message_id) DO UPDATE SET
           date = EXCLUDED.date, edit_date = EXCLUDED.edit_date, text = EXCLUDED.text, media = EXCLUDED.media,
           grouped_id = EXCLUDED.grouped_id, views = EXCLUDED.views, forwards = EXCLUDED.forwards,
           replies = EXCLUDED.replies, reactions = EXCLUDED.reactions, reply_to = EXCLUDED.reply_to,
           forwarded_from = EXCLUDED.forwarded_from, post_author = EXCLUDED.post_author,
           content_hash = EXCLUDED.content_hash, deleted = false, updated_at = now(),
           -- медиа заменили при правке — прежний разбор к нему не относится
           media_status = CASE WHEN posts.media->>'fileId' IS DISTINCT FROM EXCLUDED.media->>'fileId'
                               THEN NULL ELSE posts.media_status END,
           media_analysis = CASE WHEN posts.media->>'fileId' IS DISTINCT FROM EXCLUDED.media->>'fileId'
                                 THEN NULL ELSE posts.media_analysis END,
           media_text = CASE WHEN posts.media->>'fileId' IS DISTINCT FROM EXCLUDED.media->>'fileId'
                             THEN NULL ELSE posts.media_text END`,
        [
          post.channelId,
          post.messageId,
          post.date,
          post.editDate,
          post.text,
          post.media ? JSON.stringify(post.media) : null,
          post.groupedId,
          post.views,
          post.forwards,
          post.replies,
          post.reactions ? JSON.stringify(post.reactions) : null,
          post.replyTo,
          post.forwardedFrom ? JSON.stringify(post.forwardedFrom) : null,
          post.postAuthor,
          post.contentHash,
        ],
      );
    }
  }

  async markDeleted(channelId: number, messageIds: readonly number[]): Promise<void> {
    if (messageIds.length === 0) return;
    await this.db.query(
      `WITH gone AS (
         DELETE FROM chunks WHERE channel_id = $1 AND message_id = ANY($2::int[])
       )
       UPDATE posts SET deleted = true, updated_at = now() WHERE channel_id = $1 AND message_id = ANY($2::int[])`,
      [channelId, messageIds],
    );
  }

  async getPost(channelId: number, messageId: number): Promise<Post | undefined> {
    const [row] = await this.db.query<PostRow>(
      `SELECT ${POST_COLUMNS} FROM posts p JOIN channels c ON c.id = p.channel_id
       WHERE p.channel_id = $1 AND p.message_id = $2`,
      [channelId, messageId],
    );
    return row ? withLink(row) : undefined;
  }

  /** Все части альбома, к которому относится пост, в порядке публикации. */
  async getAlbum(channelId: number, groupedId: string): Promise<Post[]> {
    const rows = await this.db.query<PostRow>(
      `SELECT ${POST_COLUMNS} FROM posts p JOIN channels c ON c.id = p.channel_id
       WHERE p.channel_id = $1 AND p.grouped_id = $2 AND NOT p.deleted ORDER BY p.message_id`,
      [channelId, groupedId],
    );
    return rows.map(withLink);
  }

  /** Лента постов: по времени, с курсором по дате для перелистывания. */
  async listPosts(
    filter: PostFilter & { order?: "newest" | "oldest"; limit: number; offset?: number },
  ): Promise<{ posts: Post[]; total: number }> {
    const params: unknown[] = [];
    const where = filterSql(filter, params);
    const direction = filter.order === "oldest" ? "ASC" : "DESC";
    const [count] = await this.db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM posts p JOIN channels c ON c.id = p.channel_id WHERE ${where}`,
      params,
    );
    params.push(filter.limit, filter.offset ?? 0);
    const rows = await this.db.query<PostRow>(
      `SELECT ${POST_COLUMNS} FROM posts p JOIN channels c ON c.id = p.channel_id
       WHERE ${where}
       ORDER BY p.date ${direction}, p.message_id ${direction}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { posts: rows.map(withLink), total: count?.total ?? 0 };
  }

  // ── индексация ──────────────────────────────────────────────────────────

  async pendingForEmbedding(
    limit: number,
  ): Promise<Array<PostRecord & { channelTitle: string; mediaText: string | null; indexHash: string }>> {
    return this.db.query(
      `SELECT p.channel_id AS "channelId", p.message_id AS "messageId", p.date, p.text, p.media,
         p.media_text AS "mediaText", p.index_hash AS "indexHash", c.title AS "channelTitle"
       FROM posts p JOIN channels c ON c.id = p.channel_id
       WHERE p.embedded_hash IS DISTINCT FROM p.index_hash AND NOT p.deleted AND p.embed_error IS NULL
       ORDER BY p.date DESC LIMIT $1`,
      [limit],
    );
  }

  /** Заменяет куски поста и отмечает, по какому содержимому они построены. */
  async replaceChunks(
    post: { channelId: number; messageId: number; indexHash: string },
    chunks: ReadonlyArray<{ content: string; embedding: readonly number[] }>,
  ): Promise<void> {
    await this.db.query("DELETE FROM chunks WHERE channel_id = $1 AND message_id = $2", [
      post.channelId,
      post.messageId,
    ]);
    for (const [index, chunk] of chunks.entries()) {
      await this.db.query(
        `INSERT INTO chunks (channel_id, message_id, chunk_index, content, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [post.channelId, post.messageId, index, chunk.content, toVector(chunk.embedding)],
      );
    }
    await this.db.query(
      "UPDATE posts SET embedded_hash = $3, embed_error = NULL WHERE channel_id = $1 AND message_id = $2",
      [post.channelId, post.messageId, post.indexHash],
    );
  }

  async markEmbedError(channelId: number, messageId: number, error: string): Promise<void> {
    await this.db.query("UPDATE posts SET embed_error = $3 WHERE channel_id = $1 AND message_id = $2", [
      channelId,
      messageId,
      error.slice(0, 500),
    ]);
  }

  /** Сбрасывает ошибки индексации: посты снова попадут в очередь. */
  async retryEmbedErrors(): Promise<void> {
    await this.db.query("UPDATE posts SET embed_error = NULL WHERE embed_error IS NOT NULL");
    await this.db.query("UPDATE posts SET media_status = NULL, media_error = NULL WHERE media_status = 'failed'");
  }

  // ── медиа ───────────────────────────────────────────────────────────────

  /** Посты с медиа нужных типов, ещё не разобранные; сначала новые. */
  async pendingMedia(types: readonly string[], since: Date | undefined, limit: number): Promise<MediaJob[]> {
    if (types.length === 0) return [];
    return this.db.query<MediaJob>(
      `SELECT p.channel_id AS "channelId", p.message_id AS "messageId", p.date, p.text, p.media
       FROM posts p JOIN channels c ON c.id = p.channel_id
       WHERE p.media_status IS NULL AND p.media IS NOT NULL AND NOT p.deleted AND c.enabled
         AND p.media->>'type' = ANY($1::text[]) AND ($2::timestamptz IS NULL OR p.date >= $2)
       ORDER BY p.date DESC LIMIT $3`,
      [types, since ?? null, limit],
    );
  }

  async saveMediaResult(
    post: { channelId: number; messageId: number },
    result: { status: MediaStatus; analysis: MediaAnalysis | null; text: string | null; error?: string },
  ): Promise<void> {
    await this.db.query(
      `UPDATE posts SET media_status = $3, media_analysis = $4::jsonb, media_text = $5, media_error = $6
       WHERE channel_id = $1 AND message_id = $2`,
      [
        post.channelId,
        post.messageId,
        result.status,
        result.analysis ? JSON.stringify(result.analysis) : null,
        result.text,
        result.error?.slice(0, 500) ?? null,
      ],
    );
  }

  async mediaStats(types: readonly string[]): Promise<Record<string, number>> {
    const rows = await this.db.query<{ status: string; count: number }>(
      `SELECT coalesce(media_status, 'pending') AS status, count(*)::int AS count FROM posts
       WHERE media IS NOT NULL AND NOT deleted AND media->>'type' = ANY($1::text[])
       GROUP BY 1`,
      [types],
    );
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  async indexStats(): Promise<{ posts: number; indexed: number; pending: number; failed: number; chunks: number }> {
    const [row] = await this.db.query<{ posts: number; indexed: number; pending: number; failed: number; chunks: number }>(
      `SELECT
         count(*) FILTER (WHERE NOT deleted)::int AS posts,
         count(*) FILTER (WHERE NOT deleted AND embedded_hash = index_hash)::int AS indexed,
         count(*) FILTER (WHERE NOT deleted AND embedded_hash IS DISTINCT FROM index_hash AND embed_error IS NULL)::int AS pending,
         count(*) FILTER (WHERE NOT deleted AND embed_error IS NOT NULL)::int AS failed,
         (SELECT count(*)::int FROM chunks) AS chunks
       FROM posts`,
    );
    return row!;
  }

  // ── поиск ───────────────────────────────────────────────────────────────

  /** По смыслу: ближайшие куски, по одному лучшему на пост. */
  async semanticSearch(vector: readonly number[], filter: PostFilter, limit: number): Promise<SearchHit[]> {
    const params: unknown[] = [toVector(vector)];
    const where = filterSql(filter, params);
    params.push(limit * 4);
    const rows = await this.db.query<PostRow & { score: number; matched: string }>(
      `SELECT ${POST_COLUMNS}, k.score, k.content AS matched FROM (
         SELECT ch.channel_id, ch.message_id, ch.content, 1 - (ch.embedding <=> $1::vector) AS score
         FROM chunks ch
         JOIN posts p ON p.channel_id = ch.channel_id AND p.message_id = ch.message_id
         JOIN channels c ON c.id = p.channel_id
         WHERE ${where}
         ORDER BY ch.embedding <=> $1::vector
         LIMIT $${params.length}
       ) k
       JOIN posts p ON p.channel_id = k.channel_id AND p.message_id = k.message_id
       JOIN channels c ON c.id = p.channel_id
       ORDER BY k.score DESC`,
      params,
    );
    const best = new Map<string, SearchHit>();
    for (const { score, matched, ...row } of rows) {
      const key = `${row.channelId}:${row.messageId}`;
      if (!best.has(key)) best.set(key, { post: withLink(row), score: Number(score), matched });
    }
    return [...best.values()].slice(0, limit);
  }

  /** По словам: полнотекстовый поиск Postgres с русской морфологией. */
  async keywordSearch(query: string, filter: PostFilter, limit: number): Promise<SearchHit[]> {
    const params: unknown[] = [query];
    const where = filterSql(filter, params);
    params.push(limit);
    const rows = await this.db.query<PostRow & { score: number }>(
      `SELECT ${POST_COLUMNS}, ts_rank_cd(p.tsv, q) AS score
       FROM posts p JOIN channels c ON c.id = p.channel_id, websearch_to_tsquery('russian', $1) q
       WHERE p.tsv @@ q AND ${where}
       ORDER BY score DESC, p.date DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(({ score, ...row }) => ({ post: withLink(row), score: Number(score) }));
  }
}

export { searchableText };
