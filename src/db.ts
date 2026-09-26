/**
 * База: Postgres с расширением pgvector. В бою — облачный Postgres (Supabase,
 * Neon — что угодно с pgvector) или свой контейнер pgvector/pgvector; локально
 * и в проверках — PGlite, тот же Postgres, собранный в WebAssembly, с тем же
 * расширением. Код обращается к ним через один маленький интерфейс, поэтому
 * SQL здесь общий.
 */

import { readFileSync } from "node:fs";
import { logger } from "./log.ts";

const log = logger("db");

export interface Db {
  /** Один оператор с параметрами `$1…$n`. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Несколько операторов подряд, без параметров. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface PostgresOptions {
  /** Корневой сертификат сервера (PEM или путь к файлу) — у Supabase свой, не публичный. */
  caCert?: string;
  poolSize?: number;
}

export async function openDb(url: string, options: PostgresOptions = {}): Promise<Db> {
  if (url.startsWith("pglite://") || url === "memory://") return openPglite(url);
  return openPostgres(url, options);
}

/**
 * Настройки подключения из строки и окружения. Строку разбираем сами: иначе
 * параметры из неё перекрывают переданный отдельно сертификат.
 */
export async function postgresConfig(url: string, options: PostgresOptions = {}) {
  const { parse } = await import("pg-connection-string");
  const params = new URL(url).searchParams;
  // Сейчас pg понимает require как полную проверку сертификата (verify-full), а
  // со следующей версии — как libpq, без проверки. Закрепляем проверку явно:
  // сертификаты Neon публичные, для Supabase подставляется DATABASE_CA_CERT.
  const mode = params.get("sslmode");
  if (mode && ["prefer", "require", "verify-ca"].includes(mode) && !params.has("uselibpqcompat")) {
    const strict = new URL(url);
    strict.searchParams.set("sslmode", "verify-full");
    url = strict.toString();
  }
  const parsed = parse(url) as Record<string, any>;

  let ssl = parsed.ssl;
  if (options.caCert) {
    const ca = options.caCert.includes("-----BEGIN") ? options.caCert : readFileSync(options.caCert, "utf8");
    ssl = { ...(typeof ssl === "object" ? ssl : {}), ca, rejectUnauthorized: true };
  }
  const host = String(parsed.host ?? "");
  if (params.get("pgbouncer") === "true" || (String(parsed.port) === "6543" && /pooler\.supabase\.com$/.test(host))) {
    log.warn(
      "это пулер в режиме транзакций: сервис держит соединения постоянно — берите Session pooler (порт 5432) или прямое подключение",
    );
  }
  return {
    user: parsed.user,
    password: parsed.password,
    host: parsed.host,
    port: parsed.port ? Number(parsed.port) : undefined,
    database: parsed.database,
    ssl,
    // Neon кладёт в строку channel_binding=require: pg умеет его, но только по флагу.
    enableChannelBinding: params.get("channel_binding") === "require",
    max: options.poolSize ?? 5,
    // Облачные базы и NAT рвут простаивающие соединения — держим их живыми
    // и не храним простаивающие долго.
    keepAlive: true,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
  };
}

/** Понятное объяснение частых ошибок подключения к облачным базам. */
export function explainConnectionError(error: unknown, url: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  if ((code === "ENETUNREACH" || code === "EHOSTUNREACH" || code === "ENOTFOUND") && /^db\..+\.supabase\.co$/.test(host)) {
    return `${message} — прямое подключение Supabase на бесплатном тарифе только по IPv6. Возьмите строку Session pooler (Connect → Session pooler)`;
  }
  if (/self[- ]signed certificate|unable to verify|UNABLE_TO_GET_ISSUER/i.test(message)) {
    return `${message} — у Supabase свой корневой сертификат: скачайте его (Database Settings → SSL Configuration) и укажите в DATABASE_CA_CERT`;
  }
  if (/password authentication failed/i.test(message)) return `${message} — неверный пароль в DATABASE_URL`;
  if (/extension "vector" is not available|could not open extension control file/i.test(message)) {
    return `${message} — на сервере нет pgvector: нужен Postgres с этим расширением (Supabase и Neon его имеют)`;
  }
  return message;
}

async function openPostgres(url: string, options: PostgresOptions): Promise<Db> {
  const { default: pg } = await import("pg");
  // int8 — идентификаторы каналов Telegram. Они меньше 2^53, число без потерь.
  pg.types.setTypeParser(20, (value: string) => Number(value));
  const pool = new pg.Pool(await postgresConfig(url, options));
  // Облачная база может усыпить вычисления или перезапуститься: соединение
  // из пула выбрасывается, следующий запрос откроет новое.
  pool.on("error", (error) => log.warn("соединение с базой оборвалось, будет открыто новое", error));

  try {
    await pool.query("SELECT 1");
  } catch (error) {
    await pool.end().catch(() => {});
    throw new Error(`не удалось подключиться к базе: ${explainConnectionError(error, url)}`);
  }
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
  // pgvector ≥ 0.8: при фильтрах по каналу и дате индекс добирает кандидатов,
  // а не отдаёт меньше запрошенного. Настройка закрепляется за пользователем
  // базы и действует в каждом новом соединении — в том числе через пулер,
  // где SET в начале соединения теряется.
  try {
    await db.exec("ALTER ROLE CURRENT_USER SET hnsw.iterative_scan = relaxed_order");
  } catch (error) {
    log.warn("hnsw.iterative_scan не закреплён — фильтрованный поиск может вернуть меньше результатов", error);
  }
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
