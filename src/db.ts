/**
 * База: Postgres с расширением pgvector. В бою — настоящий Postgres
 * (контейнер pgvector/pgvector), локально и в проверках — PGlite, тот же
 * Postgres, собранный в WebAssembly, с тем же расширением. Код обращается к
 * обоим через один маленький интерфейс, поэтому SQL здесь общий.
 */

import { logger } from "./log.ts";

const log = logger("db");

export interface Db {
  /** Один оператор с параметрами `$1…$n`. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Несколько операторов подряд, без параметров. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function openDb(url: string): Promise<Db> {
  if (url.startsWith("pglite://") || url === "memory://") return openPglite(url);
  return openPostgres(url);
}

async function openPostgres(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  // int8 — идентификаторы каналов Telegram. Они меньше 2^53, число без потерь.
  pg.types.setTypeParser(20, (value: string) => Number(value));
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on("connect", (client) => {
    // pgvector ≥ 0.8: при фильтрах по каналу и дате индекс добирает кандидатов,
    // а не отдаёт меньше запрошенного.
    client.query("SET hnsw.iterative_scan = relaxed_order").catch(() => {});
  });
  pool.on("error", (error) => log.error("соединение с базой оборвалось", error));
  return {
    async query(sql, params = []) {
      const result = await pool.query(sql, params as unknown[]);
      return result.rows;
    },
    async exec(sql) {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

async function openPglite(url: string): Promise<Db> {
  let PGlite: typeof import("@electric-sql/pglite").PGlite;
  let vector: typeof import("@electric-sql/pglite-pgvector").vector;
  try {
    ({ PGlite } = await import("@electric-sql/pglite"));
    ({ vector } = await import("@electric-sql/pglite-pgvector"));
  } catch {
    throw new Error(
      "PGlite не установлен: локальная база доступна только с dev-зависимостями. " +
        "В бою задайте DATABASE_URL=postgres://…",
    );
  }
  const dataDir = url === "memory://" ? undefined : url.slice("pglite://".length);
  if (dataDir) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dataDir, { recursive: true });
  }
  const db = await PGlite.create({ dataDir, extensions: { vector } });
  const parsers = { 20: (value: string) => Number(value) };
  return {
    async query(sql, params = []) {
      const result = await db.query(sql, params as unknown[], { parsers });
      return result.rows as never[];
    },
    async exec(sql) {
      await db.exec(sql);
    },
    close: () => db.close(),
  };
}

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id                bigint PRIMARY KEY,
  ref               text NOT NULL,
  username          text,
  title             text NOT NULL,
  about             text,
  access_hash       text,
  enabled           boolean NOT NULL DEFAULT true,
  last_message_id   integer NOT NULL DEFAULT 0,
  backfill_done     boolean NOT NULL DEFAULT false,
  added_at          timestamptz NOT NULL DEFAULT now(),
  synced_at         timestamptz
);

CREATE TABLE IF NOT EXISTS posts (
  channel_id      bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id      integer NOT NULL,
  date            timestamptz NOT NULL,
  edit_date       timestamptz,
  text            text NOT NULL DEFAULT '',
  media           jsonb,
  grouped_id      text,
  views           integer,
  forwards        integer,
  replies         integer,
  reactions       jsonb,
  reply_to        integer,
  forwarded_from  jsonb,
  post_author     text,
  deleted         boolean NOT NULL DEFAULT false,
  content_hash    text NOT NULL,
  embedded_hash   text,
  embed_error     text,
  -- Медиа, превращённое в текст: расшифровка речи, описание, текст на картинке.
  -- NULL — ещё не разбиралось; done / skipped / failed — итог разбора.
  media_status    text,
  media_analysis  jsonb,
  media_text      text,
  media_error     text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Отпечаток всего, что индексируется: текст поста и текст из медиа.
  index_hash      text GENERATED ALWAYS AS (content_hash || coalesce(md5(media_text), '')) STORED,
  tsv             tsvector GENERATED ALWAYS AS (
                    to_tsvector('russian', text || ' ' || coalesce(media->>'searchText', '') || ' ' || coalesce(media_text, ''))
                  ) STORED,
  PRIMARY KEY (channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS posts_channel_date ON posts (channel_id, date DESC);
CREATE INDEX IF NOT EXISTS posts_date ON posts (date DESC);
CREATE INDEX IF NOT EXISTS posts_tsv ON posts USING gin (tsv);
CREATE INDEX IF NOT EXISTS posts_grouped ON posts (channel_id, grouped_id) WHERE grouped_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS posts_pending ON posts (channel_id, message_id)
  WHERE embedded_hash IS DISTINCT FROM index_hash AND NOT deleted;
CREATE INDEX IF NOT EXISTS posts_media_pending ON posts (date DESC)
  WHERE media_status IS NULL AND media IS NOT NULL AND NOT deleted;
`;

function chunksSchema(dimensions: number): string {
  return `
CREATE TABLE IF NOT EXISTS chunks (
  channel_id   bigint NOT NULL,
  message_id   integer NOT NULL,
  chunk_index  integer NOT NULL,
  content      text NOT NULL,
  embedding    vector(${dimensions}) NOT NULL,
  PRIMARY KEY (channel_id, message_id, chunk_index),
  FOREIGN KEY (channel_id, message_id) REFERENCES posts (channel_id, message_id) ON DELETE CASCADE
);
${
  // HNSW в pgvector индексирует vector не длиннее 2000 измерений.
  dimensions <= 2000
    ? "CREATE INDEX IF NOT EXISTS chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);"
    : ""
}`;
}

/**
 * Приводит базу к текущей схеме. Если модель эмбеддингов или размер вектора
 * сменились, старые векторы несравнимы с новыми: таблица кусков
 * пересоздаётся, а все посты встают в очередь на переиндексацию.
 */
export async function migrate(db: Db, embedding: { model: string; dimensions: number }): Promise<void> {
  await db.exec(SCHEMA);
  const signature = `${embedding.model}:${embedding.dimensions}`;
  const [current] = await db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'embedding'");
  if (current && current.value !== signature) {
    log.warn(`эмбеддинги сменились (${current.value} → ${signature}), переиндексация всех постов`);
    await db.exec("DROP TABLE IF EXISTS chunks; UPDATE posts SET embedded_hash = NULL, embed_error = NULL;");
  }
  await db.exec(chunksSchema(embedding.dimensions));
  await db.query(
    `INSERT INTO meta (key, value) VALUES ('embedding', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [signature],
  );
}
