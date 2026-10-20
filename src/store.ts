/**
 * Хранилище: каналы пула, посты целиком, куски с векторами и поиск по ним.
 */

import type { Db } from "./db.ts";
import { mediaSourceFingerprint, postLink, searchableText, type PostMedia, type PostRecord } from "./telegram/normalize.ts";

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
  /** Канал вне пула: срок, после которого кэш удаляется. У каналов пула — null. */
  expiresAt: Date | null;
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
}

export type AssetStorageStatus = "pending" | "stored" | "failed" | "skipped";
export type AssetEmbeddingStatus = "pending" | "done" | "failed" | "skipped";

export interface MediaAsset {
  assetId: number;
  channelId: number;
  messageId: number;
  sourceFileId: string | null;
  sourceFingerprint: string | null;
  bucket: string;
  objectKey: string | null;
  sha256: string | null;
  mimeType: string | null;
  fileName: string | null;
  size: number | null;
  duration: number | null;
  storageStatus: AssetStorageStatus;
  storageError: string | null;
  storedAt: Date | null;
  embeddingStatus: AssetEmbeddingStatus;
  embeddingError: string | null;
  updatedAt: Date;
}

export interface MediaAssetFile {
  bucket: string;
  objectKey: string;
  sha256: string;
  mimeType: string;
  fileName: string;
  size: number;
  duration?: number;
}

export interface MediaAssetReference {
  channelId: number;
  messageId: number;
  sourceFileId: string | undefined;
  sourceFingerprint: string;
}

export type ChunkKind = "text" | "image" | "audio" | "video";

export interface IndexedChunk {
  kind?: ChunkKind;
  embedding: readonly number[];
  content?: string | null;
  mediaAssetId?: number | null;
  startSeconds?: number | null;
  endSeconds?: number | null;
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
  /** Только посты старше этого номера сообщения (для перелистывания ленты). */
  beforeMessageId?: number;
  /** Только посты новее этого номера сообщения. */
  afterMessageId?: number;
  /** Читать и кэш каналов вне пула: поиск и обычная лента их не видят. */
  includeGuest?: boolean;
}

export interface SearchHit {
  post: Post;
  score: number;
  /** Кусок поста, совпавший с запросом по смыслу. */
  matched?: string | null;
  match?: {
    kind: ChunkKind;
    mediaAssetId: number | null;
    startSeconds: number | null;
    endSeconds: number | null;
  };
}

const channelColumns = (t = "") =>
  `${t}id, ${t}ref, ${t}username, ${t}title, ${t}about, ${t}access_hash AS "accessHash", ${t}enabled,
  ${t}last_message_id AS "lastMessageId", ${t}backfill_done AS "backfillDone", ${t}added_at AS "addedAt",
  ${t}synced_at AS "syncedAt", ${t}expires_at AS "expiresAt"`;
const CHANNEL_COLUMNS = channelColumns();

const POST_COLUMNS = `p.channel_id AS "channelId", c.title AS channel, c.username AS "channelUsername",
  p.message_id AS "messageId", p.date, p.edit_date AS "editDate", p.text, p.media, p.grouped_id AS "groupedId",
  p.views, p.forwards, p.replies, p.reactions, p.reply_to AS "replyTo", p.forwarded_from AS "forwardedFrom",
  p.post_author AS "postAuthor", p.deleted`;

const mediaAssetColumns = (t = "") => `${t}asset_id AS "assetId", ${t}channel_id AS "channelId", ${t}message_id AS "messageId",
  ${t}source_file_id AS "sourceFileId", ${t}source_fingerprint AS "sourceFingerprint",
  ${t}bucket, ${t}object_key AS "objectKey", ${t}sha256,
  ${t}mime_type AS "mimeType", ${t}file_name AS "fileName", ${t}size, ${t}duration,
  ${t}storage_status AS "storageStatus", ${t}storage_error AS "storageError", ${t}stored_at AS "storedAt",
  ${t}embedding_status AS "embeddingStatus", ${t}embedding_error AS "embeddingError", ${t}updated_at AS "updatedAt"`;
const MEDIA_ASSET_COLUMNS = mediaAssetColumns();

type PostRow = Omit<Post, "link">;

const withLink = (row: PostRow): Post => ({
  ...row,
  link: postLink({ id: row.channelId, username: row.channelUsername }, row.messageId),
});

/** Условия фильтра, начиная с параметра `$<offset+1>`. */
function filterSql(filter: PostFilter, params: unknown[]): string {
  const where = ["NOT p.deleted"];
  // Вне пула посты живут только в кэше и в поиске не участвуют.
  if (!filter.includeGuest) where.push("c.enabled", "c.expires_at IS NULL");
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
  if (filter.beforeMessageId !== undefined) {
    params.push(filter.beforeMessageId);
    where.push(`p.message_id < $${params.length}`);
  }
  if (filter.afterMessageId !== undefined) {
    params.push(filter.afterMessageId);
    where.push(`p.message_id > $${params.length}`);
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
         enabled = true, expires_at = NULL
       RETURNING ${CHANNEL_COLUMNS}`,
      [channel.id, channel.ref, channel.username, channel.title, channel.about, channel.accessHash],
    );
    return row!;
  }

  /**
   * Канал вне пула: живёт в том же справочнике, но с датой удаления.
   * Повторное чтение продлевает срок; канал пула гостем не становится.
   */
  async upsertGuestChannel(
    channel: {
      id: number;
      ref: string;
      username: string | null;
      title: string;
      about: string | null;
      accessHash: string | null;
    },
    ttlSeconds: number,
  ): Promise<Channel> {
    const [row] = await this.db.query<Channel>(
      `INSERT INTO channels (id, ref, username, title, about, access_hash, enabled, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, now() + $7::int * interval '1 second')
       ON CONFLICT (id) DO UPDATE SET
         ref = EXCLUDED.ref, username = EXCLUDED.username, title = EXCLUDED.title,
         about = COALESCE(EXCLUDED.about, channels.about),
         access_hash = COALESCE(EXCLUDED.access_hash, channels.access_hash),
         expires_at = CASE
           WHEN channels.expires_at IS NULL AND channels.enabled THEN NULL
           ELSE now() + $7::int * interval '1 second'
         END
       RETURNING ${CHANNEL_COLUMNS}`,
      [channel.id, channel.ref, channel.username, channel.title, channel.about, channel.accessHash, ttlSeconds],
    );
    return row!;
  }

  /** Удаляет гостевые каналы с истёкшим сроком вместе с их постами. */
  async purgeExpiredGuestChannels(): Promise<number> {
    const rows = await this.db.query<{ id: number }>(
      "DELETE FROM channels WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING id",
    );
    return rows.length;
  }

  /** Оставляет не больше `max` гостевых каналов: давно не читанные удаляются первыми. */
  async trimGuestChannels(max: number): Promise<number> {
    const rows = await this.db.query<{ id: number }>(
      `WITH excess AS (
         SELECT id FROM channels WHERE expires_at IS NOT NULL
         ORDER BY expires_at DESC OFFSET $1
       )
       DELETE FROM channels WHERE id IN (SELECT id FROM excess) RETURNING id`,
      [max],
    );
    return rows.length;
  }

  async listChannels(options: { includeDisabled?: boolean; includeGuest?: boolean } = {}): Promise<Channel[]> {
    const where = [];
    if (!options.includeDisabled) where.push("enabled");
    if (!options.includeGuest) where.push("expires_at IS NULL");
    return this.db.query<Channel>(
      `SELECT ${CHANNEL_COLUMNS} FROM channels ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY added_at`,
    );
  }

  async channelStats(
    mediaTypes: readonly string[] = [],
  ): Promise<Array<Channel & { posts: number; indexed: number; firstPost: Date | null; lastPost: Date | null }>> {
    return this.db.query(
      `SELECT ${channelColumns("c.")},
         count(p.message_id) FILTER (WHERE NOT p.deleted)::int AS posts,
         count(p.message_id) FILTER (
           WHERE NOT p.deleted AND p.embedded_hash = p.index_hash AND NOT EXISTS (
             SELECT 1 FROM media_assets a WHERE a.channel_id = p.channel_id AND a.message_id = p.message_id
               AND p.media->>'type' = ANY($1::text[])
               AND (a.storage_status IN ('pending', 'failed') OR
                 (a.storage_status = 'stored' AND a.embedding_status IN ('pending', 'failed')))
           )
         )::int AS indexed,
         min(p.date) FILTER (WHERE NOT p.deleted) AS "firstPost",
         max(p.date) FILTER (WHERE NOT p.deleted) AS "lastPost"
       FROM channels c LEFT JOIN posts p ON p.channel_id = c.id
       WHERE c.enabled AND c.expires_at IS NULL
       GROUP BY c.id ORDER BY c.added_at`,
      [mediaTypes],
    );
  }

  /** Канал по @имени, ссылке, id или исходной записи, с которой его добавили. */
  async findChannel(ref: string | number): Promise<Channel | undefined> {
    const value = String(ref).trim();
    const username = value
      .replace(/^https?:\/\/(t|telegram)\.me\//i, "")
      .replace(/^s\//, "")
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
      await this.db.transaction(async (tx) => {
        const [existing] = await tx.query<{ media: PostMedia | null }>(
          `SELECT media FROM posts WHERE channel_id = $1 AND message_id = $2 FOR UPDATE`,
          [post.channelId, post.messageId],
        );
        const attachmentChangedWithoutFileId = Boolean(
          existing && !existing.media?.fileId && !post.media?.fileId &&
          mediaSourceFingerprint(existing.media) !== mediaSourceFingerprint(post.media),
        );
        await tx.query(
          `INSERT INTO posts (channel_id, message_id, date, edit_date, text, media, grouped_id, views, forwards,
             replies, reactions, reply_to, forwarded_from, post_author, content_hash, deleted, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14, $15, false, now())
           ON CONFLICT (channel_id, message_id) DO UPDATE SET
             date = EXCLUDED.date, edit_date = EXCLUDED.edit_date, text = EXCLUDED.text, media = EXCLUDED.media,
             grouped_id = EXCLUDED.grouped_id, views = EXCLUDED.views, forwards = EXCLUDED.forwards,
             replies = EXCLUDED.replies, reactions = EXCLUDED.reactions, reply_to = EXCLUDED.reply_to,
             forwarded_from = EXCLUDED.forwarded_from, post_author = EXCLUDED.post_author,
             content_hash = EXCLUDED.content_hash, deleted = false, updated_at = now()`,
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
        await tx.query(
          `DELETE FROM media_assets
           WHERE channel_id = $1 AND message_id = $2
             AND (source_file_id IS DISTINCT FROM $3 OR $4)`,
          [post.channelId, post.messageId, post.media?.fileId ?? null, attachmentChangedWithoutFileId],
        );
      });
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

  /** Несколько постов канала по номерам сообщений — для кэша и альбомов. */
  async getPosts(channelId: number, messageIds: readonly number[]): Promise<Post[]> {
    if (messageIds.length === 0) return [];
    const rows = await this.db.query<PostRow>(
      `SELECT ${POST_COLUMNS} FROM posts p JOIN channels c ON c.id = p.channel_id
       WHERE p.channel_id = $1 AND p.message_id = ANY($2::int[]) AND NOT p.deleted
       ORDER BY p.message_id`,
      [channelId, messageIds],
    );
    return rows.map(withLink);
  }

  /** Лента постов: по времени или по номерам сообщений, с перелистыванием. */
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
    mediaTypes: readonly string[] = [],
  ): Promise<Array<PostRecord & { channelTitle: string; indexHash: string }>> {
    return this.db.query(
      `SELECT p.channel_id AS "channelId", p.message_id AS "messageId", p.date, p.text, p.media,
         p.index_hash AS "indexHash", c.title AS "channelTitle"
       FROM posts p JOIN channels c ON c.id = p.channel_id
       LEFT JOIN media_assets a ON a.channel_id = p.channel_id AND a.message_id = p.message_id
       WHERE NOT p.deleted AND c.expires_at IS NULL AND p.embed_error IS NULL AND (
         p.embedded_hash IS DISTINCT FROM p.index_hash
         OR (p.media->>'type' = ANY($2::text[]) AND (
           a.asset_id IS NULL OR a.storage_status = 'pending'
           OR (a.storage_status = 'stored' AND a.embedding_status = 'pending')
         ))
       )
       ORDER BY p.date DESC LIMIT $1`,
      [limit, mediaTypes],
    );
  }

  /** Заменяет куски поста и отмечает, по какому содержимому они построены. */
  async replaceChunks(
    post: { channelId: number; messageId: number; indexHash: string },
    chunks: ReadonlyArray<IndexedChunk>,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.query<{ indexHash: string }>(
        `SELECT index_hash AS "indexHash" FROM posts
         WHERE channel_id = $1 AND message_id = $2 AND NOT deleted FOR UPDATE`,
        [post.channelId, post.messageId],
      );
      if (!current || current.indexHash !== post.indexHash) return false;

      await tx.query("DELETE FROM chunks WHERE channel_id = $1 AND message_id = $2", [
        post.channelId,
        post.messageId,
      ]);
      for (const [index, chunk] of chunks.entries()) {
        await tx.query(
          `INSERT INTO chunks (
             channel_id, message_id, chunk_index, kind, media_asset_id, start_seconds, end_seconds, content, embedding
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)`,
          [
            post.channelId,
            post.messageId,
            index,
            chunk.kind ?? "text",
            chunk.mediaAssetId ?? null,
            chunk.startSeconds ?? null,
            chunk.endSeconds ?? null,
            chunk.content ?? null,
            toVector(chunk.embedding),
          ],
        );
      }
      await tx.query(
        "UPDATE posts SET embedded_hash = $3, embed_error = NULL WHERE channel_id = $1 AND message_id = $2",
        [post.channelId, post.messageId, post.indexHash],
      );
      const assetIds = [...new Set(chunks.map((chunk) => chunk.mediaAssetId).filter((id): id is number => id != null))];
      if (assetIds.length > 0) {
        await tx.query(
          `UPDATE media_assets SET embedding_status = 'done', embedding_error = NULL, updated_at = now()
           WHERE asset_id = ANY($1::bigint[]) AND storage_status = 'stored'`,
          [assetIds],
        );
      }
      return true;
    });
  }

  async getMediaAsset(channelId: number, messageId: number): Promise<MediaAsset | undefined> {
    const [asset] = await this.db.query<MediaAsset>(
      `SELECT ${MEDIA_ASSET_COLUMNS} FROM media_assets WHERE channel_id = $1 AND message_id = $2`,
      [channelId, messageId],
    );
    return asset;
  }

  async getMediaAssetsForPosts(posts: readonly Pick<Post, "channelId" | "messageId">[]): Promise<MediaAsset[]> {
    const unique = [...new Map(posts.map((post) => [`${post.channelId}:${post.messageId}`, post])).values()];
    if (unique.length === 0) return [];
    const params: unknown[] = [];
    const values = unique.map((post) => {
      params.push(post.channelId, post.messageId);
      const channelParam = params.length - 1;
      const messageParam = params.length;
      return `($${channelParam}::bigint, $${messageParam}::integer)`;
    });
    return this.db.query<MediaAsset>(
      `SELECT ${mediaAssetColumns("a.")} FROM media_assets a
       JOIN (VALUES ${values.join(", ")}) AS requested(channel_id, message_id)
         ON requested.channel_id = a.channel_id AND requested.message_id = a.message_id`,
      params,
    );
  }

  async ensureMediaAsset(input: {
    channelId: number;
    messageId: number;
    sourceFileId: string | undefined;
    sourceFingerprint: string;
    bucket: string;
    fileName: string | undefined;
    mimeType: string | undefined;
    size: number | undefined;
    duration: number | undefined;
  }): Promise<MediaAsset | undefined> {
    return this.db.transaction(async (tx) => {
      const [post] = await tx.query<{ media: PostMedia | null }>(
        `SELECT media FROM posts
         WHERE channel_id = $1 AND message_id = $2 AND NOT deleted FOR UPDATE`,
        [input.channelId, input.messageId],
      );
      if (
        !post ||
        (post.media?.fileId ?? null) !== (input.sourceFileId ?? null) ||
        mediaSourceFingerprint(post.media) !== input.sourceFingerprint
      ) return undefined;

      const [existing] = await tx.query<MediaAsset>(
        `SELECT ${MEDIA_ASSET_COLUMNS} FROM media_assets WHERE channel_id = $1 AND message_id = $2 FOR UPDATE`,
        [input.channelId, input.messageId],
      );
      if (
        existing &&
        existing.sourceFileId === (input.sourceFileId ?? null) &&
        existing.bucket === input.bucket &&
        (existing.sourceFingerprint === input.sourceFingerprint || input.sourceFileId != null)
      ) {
        // Для сохранённого файла имя, тип, размер и длительность уже измерены по самим байтам;
        // заявленные Telegram значения (у фото их нет вовсе) их не затирают.
        const [updated] = await tx.query<MediaAsset>(
          `UPDATE media_assets SET source_fingerprint = $2,
             file_name = CASE WHEN storage_status = 'stored' THEN file_name ELSE $3 END,
             mime_type = CASE WHEN storage_status = 'stored' THEN mime_type ELSE $4 END,
             size = CASE WHEN storage_status = 'stored' THEN size ELSE $5 END,
             duration = CASE WHEN storage_status = 'stored' THEN duration ELSE $6 END,
             updated_at = now()
           WHERE asset_id = $1 RETURNING ${MEDIA_ASSET_COLUMNS}`,
          [
            existing.assetId,
            input.sourceFingerprint,
            input.fileName ?? null,
            input.mimeType ?? null,
            input.size ?? null,
            input.duration ?? null,
          ],
        );
        return updated;
      }

      // Вложение заменили другим файлом: векторы старого больше не описывают пост.
      if (existing) await tx.query("DELETE FROM chunks WHERE media_asset_id = $1", [existing.assetId]);

      const [asset] = await tx.query<MediaAsset>(
        `INSERT INTO media_assets (
           channel_id, message_id, source_file_id, source_fingerprint, bucket, file_name, mime_type, size, duration
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (channel_id, message_id) DO UPDATE SET
           source_file_id = EXCLUDED.source_file_id, source_fingerprint = EXCLUDED.source_fingerprint,
           bucket = EXCLUDED.bucket,
           object_key = NULL, sha256 = NULL, mime_type = EXCLUDED.mime_type,
           file_name = EXCLUDED.file_name, size = EXCLUDED.size, duration = EXCLUDED.duration,
           storage_status = 'pending', storage_error = NULL, stored_at = NULL,
           embedding_status = 'pending', embedding_error = NULL, updated_at = now()
         RETURNING ${MEDIA_ASSET_COLUMNS}`,
        [
          input.channelId,
          input.messageId,
          input.sourceFileId ?? null,
          input.sourceFingerprint,
          input.bucket,
          input.fileName ?? null,
          input.mimeType ?? null,
          input.size ?? null,
          input.duration ?? null,
        ],
      );
      return asset;
    });
  }

  async saveMediaAssetFile(
    post: MediaAssetReference,
    file: MediaAssetFile,
  ): Promise<MediaAsset | undefined> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.query<{ media: PostMedia | null }>(
        `SELECT media FROM posts
         WHERE channel_id = $1 AND message_id = $2 AND NOT deleted FOR UPDATE`,
        [post.channelId, post.messageId],
      );
      if (
        !current ||
        (current.media?.fileId ?? null) !== (post.sourceFileId ?? null) ||
        mediaSourceFingerprint(current.media) !== post.sourceFingerprint
      ) return undefined;

      const [asset] = await tx.query<MediaAsset>(
        `INSERT INTO media_assets (
           channel_id, message_id, source_file_id, source_fingerprint, bucket, object_key, sha256, mime_type,
           file_name, size, duration, storage_status, storage_error, stored_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'stored', NULL, now(), now())
         ON CONFLICT (channel_id, message_id) DO UPDATE SET
           source_fingerprint = EXCLUDED.source_fingerprint, bucket = EXCLUDED.bucket,
           object_key = EXCLUDED.object_key, sha256 = EXCLUDED.sha256,
           mime_type = EXCLUDED.mime_type, file_name = EXCLUDED.file_name, size = EXCLUDED.size,
           duration = EXCLUDED.duration, storage_status = 'stored', storage_error = NULL,
           stored_at = now(), embedding_status = 'pending', embedding_error = NULL, updated_at = now()
         WHERE media_assets.source_file_id IS NOT DISTINCT FROM EXCLUDED.source_file_id
           AND media_assets.source_fingerprint = EXCLUDED.source_fingerprint
         RETURNING ${MEDIA_ASSET_COLUMNS}`,
        [
          post.channelId,
          post.messageId,
          post.sourceFileId ?? null,
          post.sourceFingerprint,
          file.bucket,
          file.objectKey,
          file.sha256,
          file.mimeType,
          file.fileName,
          file.size,
          file.duration ?? null,
        ],
      );
      return asset;
    });
  }

  /**
   * Сбой загрузки не должен затирать оригинал, который успела сохранить
   * параллельная загрузка. `allowStored` нужен только когда ошибка относится
   * к чтению уже сохранённого объекта из S3.
   */
  async markMediaStorageFailed(
    post: MediaAssetReference,
    error: string,
    options: { allowStored?: boolean } = {},
  ): Promise<void> {
    await this.db.query(
      `UPDATE media_assets SET storage_status = 'failed', storage_error = $5, updated_at = now()
       WHERE channel_id = $1 AND message_id = $2
         AND source_file_id IS NOT DISTINCT FROM $3 AND source_fingerprint = $4
         AND (storage_status <> 'stored' OR $6::boolean)`,
      [
        post.channelId,
        post.messageId,
        post.sourceFileId ?? null,
        post.sourceFingerprint,
        error.slice(0, 500),
        options.allowStored ?? false,
      ],
    );
  }

  async markMediaStorageSkipped(
    post: MediaAssetReference,
    reason: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE media_assets SET storage_status = 'skipped', storage_error = $5, updated_at = now()
       WHERE channel_id = $1 AND message_id = $2
         AND source_file_id IS NOT DISTINCT FROM $3 AND source_fingerprint = $4
         AND storage_status <> 'stored'`,
      [post.channelId, post.messageId, post.sourceFileId ?? null, post.sourceFingerprint, reason.slice(0, 500)],
    );
  }

  async markEmbedErrorIfCurrent(
    post: { channelId: number; messageId: number; indexHash: string },
    error: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.query<{ indexHash: string }>(
        `SELECT index_hash AS "indexHash" FROM posts
         WHERE channel_id = $1 AND message_id = $2 AND NOT deleted FOR UPDATE`,
        [post.channelId, post.messageId],
      );
      if (!current || current.indexHash !== post.indexHash) return false;
      const value = error.slice(0, 500);
      await tx.query("UPDATE posts SET embed_error = $3 WHERE channel_id = $1 AND message_id = $2", [
        post.channelId,
        post.messageId,
        value,
      ]);
      await tx.query(
        `UPDATE media_assets SET
           storage_status = CASE WHEN storage_status = 'pending' THEN 'failed' ELSE storage_status END,
           storage_error = CASE WHEN storage_status = 'pending' THEN $3 ELSE storage_error END,
           embedding_status = CASE WHEN storage_status = 'stored' AND embedding_status = 'pending' THEN 'failed' ELSE embedding_status END,
           embedding_error = CASE WHEN storage_status = 'stored' AND embedding_status = 'pending' THEN $3 ELSE embedding_error END,
           updated_at = now()
         WHERE channel_id = $1 AND message_id = $2`,
        [post.channelId, post.messageId, value],
      );
      return true;
    });
  }

  /** Сбрасывает ошибки индексации: посты снова попадут в очередь. */
  async retryEmbedErrors(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query("UPDATE posts SET embed_error = NULL WHERE embed_error IS NOT NULL");
      await tx.query(
        `UPDATE media_assets SET
           storage_status = CASE WHEN storage_status = 'failed' THEN 'pending' ELSE storage_status END,
           storage_error = CASE WHEN storage_status = 'failed' THEN NULL ELSE storage_error END,
           embedding_status = CASE WHEN embedding_status = 'failed' THEN 'pending' ELSE embedding_status END,
           embedding_error = CASE WHEN embedding_status = 'failed' THEN NULL ELSE embedding_error END,
           updated_at = now()
         WHERE storage_status = 'failed' OR embedding_status = 'failed'`,
      );
    });
  }

  // ── медиа ───────────────────────────────────────────────────────────────

  async markMediaEmbeddingFailed(
    post: MediaAssetReference,
    error: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE media_assets SET embedding_status = 'failed', embedding_error = $5, updated_at = now()
       WHERE channel_id = $1 AND message_id = $2
         AND source_file_id IS NOT DISTINCT FROM $3 AND source_fingerprint = $4`,
      [post.channelId, post.messageId, post.sourceFileId ?? null, post.sourceFingerprint, error.slice(0, 500)],
    );
  }

  async markMediaEmbeddingSkipped(
    post: MediaAssetReference,
    reason: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE media_assets SET embedding_status = 'skipped', embedding_error = $5, updated_at = now()
       WHERE channel_id = $1 AND message_id = $2
         AND source_file_id IS NOT DISTINCT FROM $3 AND source_fingerprint = $4`,
      [post.channelId, post.messageId, post.sourceFileId ?? null, post.sourceFingerprint, reason.slice(0, 500)],
    );
  }

  async mediaStats(types: readonly string[]): Promise<{
    storage: Record<AssetStorageStatus, number>;
    embedding: Record<AssetEmbeddingStatus, number>;
  }> {
    const [storageRows, embeddingRows] = await Promise.all([
      this.db.query<{ status: AssetStorageStatus; count: number }>(
        `SELECT coalesce(a.storage_status, 'pending') AS status, count(*)::int AS count
         FROM posts p LEFT JOIN media_assets a ON a.channel_id = p.channel_id AND a.message_id = p.message_id
         WHERE p.media IS NOT NULL AND NOT p.deleted AND p.media->>'type' = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = p.channel_id AND c.expires_at IS NOT NULL)
         GROUP BY 1`,
        [types],
      ),
      this.db.query<{ status: AssetEmbeddingStatus; count: number }>(
        `SELECT coalesce(a.embedding_status, 'pending') AS status, count(*)::int AS count
         FROM posts p LEFT JOIN media_assets a ON a.channel_id = p.channel_id AND a.message_id = p.message_id
         WHERE p.media IS NOT NULL AND NOT p.deleted AND p.media->>'type' = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = p.channel_id AND c.expires_at IS NOT NULL)
         GROUP BY 1`,
        [types],
      ),
    ]);
    const storage: Record<AssetStorageStatus, number> = { pending: 0, stored: 0, failed: 0, skipped: 0 };
    const embedding: Record<AssetEmbeddingStatus, number> = { pending: 0, done: 0, failed: 0, skipped: 0 };
    for (const row of storageRows) storage[row.status] = row.count;
    for (const row of embeddingRows) embedding[row.status] = row.count;
    return { storage, embedding };
  }

  async indexStats(
    mediaTypes: readonly string[] = [],
  ): Promise<{ posts: number; indexed: number; pending: number; failed: number; chunks: number }> {
    const [row] = await this.db.query<{ posts: number; indexed: number; pending: number; failed: number; chunks: number }>(
      `SELECT
         count(*) FILTER (WHERE NOT deleted)::int AS posts,
         count(*) FILTER (
           WHERE NOT deleted AND embedded_hash = index_hash AND embed_error IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM media_assets a WHERE a.channel_id = posts.channel_id AND a.message_id = posts.message_id
                 AND posts.media->>'type' = ANY($1::text[])
                 AND (a.storage_status IN ('pending', 'failed') OR
                   (a.storage_status = 'stored' AND a.embedding_status IN ('pending', 'failed')))
             )
         )::int AS indexed,
         count(*) FILTER (
           WHERE NOT deleted AND embed_error IS NULL AND (
             embedded_hash IS DISTINCT FROM index_hash OR EXISTS (
               SELECT 1 FROM media_assets a WHERE a.channel_id = posts.channel_id AND a.message_id = posts.message_id
                 AND posts.media->>'type' = ANY($1::text[])
                 AND (a.storage_status = 'pending' OR (a.storage_status = 'stored' AND a.embedding_status = 'pending'))
             )
           )
         )::int AS pending,
         count(*) FILTER (
           WHERE NOT deleted AND (embed_error IS NOT NULL OR EXISTS (
             SELECT 1 FROM media_assets a WHERE a.channel_id = posts.channel_id AND a.message_id = posts.message_id
               AND posts.media->>'type' = ANY($1::text[])
               AND (a.storage_status = 'failed' OR a.embedding_status = 'failed')
           ))
         )::int AS failed,
         (SELECT count(*)::int FROM chunks) AS chunks
        FROM posts
        WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = posts.channel_id AND c.expires_at IS NOT NULL)`,
      [mediaTypes],
    );
    return row!;
  }

  // ── поиск ───────────────────────────────────────────────────────────────

  /** По смыслу: ближайшие куски, по одному лучшему на пост. */
  async semanticSearch(vector: readonly number[], filter: PostFilter, limit: number): Promise<SearchHit[]> {
    const params: unknown[] = [toVector(vector)];
    const where = filterSql(filter, params);
    params.push(limit * 4);
    const rows = await this.db.query<PostRow & {
      score: number;
      matched: string | null;
      matchedKind: ChunkKind;
      mediaAssetId: number | null;
      startSeconds: number | null;
      endSeconds: number | null;
    }>(
      `SELECT ${POST_COLUMNS}, k.score, k.content AS matched,
         k.kind AS "matchedKind", k.media_asset_id AS "mediaAssetId",
         k.start_seconds AS "startSeconds", k.end_seconds AS "endSeconds" FROM (
         SELECT ch.channel_id, ch.message_id, ch.content, ch.kind, ch.media_asset_id,
           ch.start_seconds, ch.end_seconds, 1 - (ch.embedding <=> $1::vector) AS score
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
     for (const { score, matched, matchedKind, mediaAssetId, startSeconds, endSeconds, ...row } of rows) {
       const key = `${row.channelId}:${row.messageId}`;
       if (!best.has(key)) {
         best.set(key, {
           post: withLink(row),
           score: Number(score),
           matched,
           match: {
             kind: matchedKind,
             mediaAssetId,
             startSeconds,
             endSeconds,
           },
         });
       }
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
