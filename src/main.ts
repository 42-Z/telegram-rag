/** Точка входа: база → единая очередь индексации → userbot → HTTP/MCP. */

import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { explainConnectionError, migrate, openDb } from "./db.ts";
import { createEmbedder } from "./embeddings.ts";
import { createApp } from "./http.ts";
import { Indexer } from "./indexer.ts";
import { logger, setLogLevel } from "./log.ts";
import { MEDIA_ARCHIVE_MAX_BYTES, MEDIA_EMBED_MAX_BYTES, MEDIA_EMBED_MAX_SECONDS } from "./media/limits.ts";
import { MEDIA_TYPES, mediaModality } from "./media/prepare.ts";
import { createObjectStorage } from "./storage.ts";
import { Store } from "./store.ts";
import { createClient } from "./telegram/client.ts";
import { Ingestor } from "./telegram/ingest.ts";
import { GUEST_CACHE, GuestReader, createChannelSource } from "./telegram/reader.ts";

const log = logger("main");
const config = loadConfig();
setLogLevel(config.LOG_LEVEL);

let db: Awaited<ReturnType<typeof openDb>>;
try {
  db = await openDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT, poolSize: config.DATABASE_POOL_SIZE });
  await migrate(db, {
    model: config.embedding.model,
    dimensions: config.embedding.dimensions,
    mediaProfile: JSON.stringify({
      modalities: [...config.embedding.modalities].sort(),
      mediaTypes: [...MEDIA_TYPES].sort(),
      mediaSince: config.MEDIA_SINCE ?? null,
      segmentSeconds: config.MEDIA_SEGMENT_SECONDS,
      segmentOverlapSeconds: config.MEDIA_SEGMENT_OVERLAP_SECONDS,
      maxArchiveMb: MEDIA_ARCHIVE_MAX_BYTES / 1_048_576,
      maxEmbedMb: MEDIA_EMBED_MAX_BYTES / 1_048_576,
      maxEmbedSeconds: MEDIA_EMBED_MAX_SECONDS,
    }),
  });
} catch (error) {
  const connect = error instanceof Error && error.message.startsWith("не удалось подключиться");
  log.error(connect ? (error as Error).message : explainConnectionError(error, config.DATABASE_URL));
  process.exit(1);
}

const store = new Store(db);
// Конфиг гарантирует, что S3 настроен: оригиналы медиа хранятся только там.
const storage = createObjectStorage({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION!,
  bucket: config.S3_BUCKET!,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY_ID!,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
    ...(config.S3_SESSION_TOKEN ? { sessionToken: config.S3_SESSION_TOKEN } : {}),
    ...(config.S3_CREDENTIALS_EXPIRES_AT
      ? { expiration: new Date(config.S3_CREDENTIALS_EXPIRES_AT) }
      : {}),
  },
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  urlTtlSeconds: config.S3_URL_TTL_SECONDS,
});

const embedder = createEmbedder(config.embedding);
log.info(
  `эмбеддинги (${config.embedding.api}): ${config.embedding.model} (${config.embedding.dimensions}) ` +
    `через ${config.embedding.baseURL}; медиа: ${config.embedding.modalities.join(", ")}`,
);
const archiveOnly = MEDIA_TYPES.filter((type) => {
  const modality = mediaModality(type);
  return !modality || !embedder.modalities.has(modality);
});
if (archiveOnly.length > 0) {
  log.info(`модель не принимает эти типы медиа — они сохраняются в S3 без векторов: ${archiveOnly.join(", ")}`);
}

let ingestor: Ingestor | undefined;
let indexer: Indexer | undefined;
let guests: GuestReader | undefined;
if (config.telegramEnabled) {
  const client = createClient({
    apiId: config.TELEGRAM_API_ID!,
    apiHash: config.TELEGRAM_API_HASH!,
    session: config.TELEGRAM_SESSION!,
  });
  ingestor = new Ingestor(client, store, {
    backfillLimit: config.BACKFILL_LIMIT,
    pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
    onPosts: () => indexer?.notify(),
  });
  guests = new GuestReader(store, createChannelSource(client), {
    ttlSeconds: GUEST_CACHE.ttlSeconds,
    maxChannels: GUEST_CACHE.maxChannels,
  });
}

// Каналы вне пула — временный кэш: истёкшие удаляются вместе с постами,
// а если кэш вырос больше лимита, первыми уходят давно не читанные.
const GUEST_CLEANUP_MS = 60_000;
async function purgeGuests(): Promise<void> {
  try {
    const purged = await store.purgeExpiredGuestChannels();
    const trimmed = await store.trimGuestChannels(GUEST_CACHE.maxChannels);
    if (purged + trimmed > 0) {
      log.info(`каналы вне пула: удалено истёкших ${purged}, сверх лимита ${trimmed}`);
    }
  } catch (error) {
    log.warn("не удалось удалить истёкший кэш каналов вне пула", error);
  }
}
void purgeGuests();
const guestCleanup = setInterval(() => void purgeGuests(), GUEST_CLEANUP_MS);
guestCleanup.unref();

const source = ingestor;
indexer = new Indexer(store, embedder, {
  batchSize: config.EMBEDDING_BATCH_SIZE,
  concurrency: config.MEDIA_CONCURRENCY,
  // Сохранённые оригиналы читаются из S3 и без Telegram, поэтому типы нужны всегда:
  // иначе переиндексация без Telegram стёрла бы векторы медиа.
  mediaTypes: MEDIA_TYPES,
  mediaSince: config.mediaSince,
  maxArchiveBytes: MEDIA_ARCHIVE_MAX_BYTES,
  maxEmbedBytes: MEDIA_EMBED_MAX_BYTES,
  maxEmbedSeconds: MEDIA_EMBED_MAX_SECONDS,
  segmentSeconds: config.MEDIA_SEGMENT_SECONDS,
  segmentOverlapSeconds: config.MEDIA_SEGMENT_OVERLAP_SECONDS,
  storage,
  ...(source
    ? {
        downloadMedia: (channelId: number, messageId: number, expected) =>
          source.downloadMedia(channelId, messageId, expected),
        downloadMediaToFile: (channelId: number, messageId: number, expected, path: string) =>
          source.downloadMediaToFile(channelId, messageId, expected, path),
      }
    : {}),
});
if (source) {
  log.info(`единая очередь: оригиналы всех типов в S3, векторы для ${config.embedding.modalities.join(", ")}`);
}

if (ingestor) {
  void ingestor.start(config.TELEGRAM_CHANNELS).then(() => indexer?.start()).catch((error) => {
    log.error("Telegram не запустился — проверьте TELEGRAM_* и сессию (npm run login)", error);
    process.exit(1);
  });
} else {
  log.warn("Telegram выключен: нет TELEGRAM_API_ID/TELEGRAM_API_HASH/TELEGRAM_SESSION — отдаются только уже собранные посты");
  indexer?.start();
}

const app = createApp({
  context: {
    store,
    embedder,
    storage,
    mediaTypes: MEDIA_TYPES,
    ensureMedia: (post) => indexer!.ensureOriginal(post),
    guests,
  },
  mediaTypes: MEDIA_TYPES,
  ingestor,
  apiToken: config.API_TOKEN,
  adminToken: config.ADMIN_TOKEN,
  publicUrl: config.PUBLIC_URL,
});

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: "0.0.0.0" }, (info) =>
  log.info(`слушаю :${info.port} — MCP на /mcp, OpenAPI на /openapi.json`),
);

let closing = false;
/** Docker по умолчанию ждёт 10 с после SIGTERM, потом убивает процесс без закрытия базы. */
const SHUTDOWN_TIMEOUT_MS = 8_000;
async function shutdown(signal: string) {
  if (closing) {
    log.warn(`${signal}: повторный сигнал, выхожу сразу`);
    process.exit(1);
  }
  closing = true;
  log.info(`${signal}: остановка`);
  // Эмбеддинг в полёте или скачивание файла остановить нельзя; пост при этом остаётся в очереди.
  setTimeout(() => {
    log.error("остановка не уложилась в срок, выхожу принудительно");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  server.close();
  clearInterval(guestCleanup);
  await indexer?.stop().catch(() => {});
  await ingestor?.stop().catch(() => {});
  await storage.close().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
