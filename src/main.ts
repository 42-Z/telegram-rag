/**
 * Точка входа: база → индексатор → userbot → HTTP.
 *
 * Один процесс на purpose: сессия Telegram живёт в памяти, две копии с одной
 * сессией конфликтуют.
 */

import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { migrate, openDb } from "./db.ts";
import { createEmbedder, type Embedder } from "./embeddings.ts";
import { createApp } from "./http.ts";
import { Indexer } from "./indexer.ts";
import { createAnalyzer } from "./media/analyzer.ts";
import { MediaProcessor } from "./media/processor.ts";
import { logger, setLogLevel } from "./log.ts";
import { Store } from "./store.ts";
import { createClient } from "./telegram/client.ts";
import { Ingestor } from "./telegram/ingest.ts";

const log = logger("main");
const config = loadConfig();
setLogLevel(config.LOG_LEVEL);

const db = await openDb(config.DATABASE_URL);
await migrate(db, { model: config.EMBEDDING_MODEL, dimensions: config.EMBEDDING_DIMENSIONS });
const store = new Store(db);

let embedder: Embedder | undefined;
let indexer: Indexer | undefined;
const localEmbeddings = !/openrouter\.ai|api\.openai\.com/.test(config.EMBEDDING_BASE_URL);
if (config.EMBEDDING_API_KEY || localEmbeddings) {
  embedder = createEmbedder({
    baseURL: config.EMBEDDING_BASE_URL,
    apiKey: config.EMBEDDING_API_KEY,
    model: config.EMBEDDING_MODEL,
    dimensions: config.EMBEDDING_DIMENSIONS,
    sendDimensions: config.EMBEDDING_SEND_DIMENSIONS,
  });
  indexer = new Indexer(store, embedder, config.EMBEDDING_BATCH_SIZE);
  indexer.start();
  log.info(`эмбеддинги: ${config.EMBEDDING_MODEL} (${config.EMBEDDING_DIMENSIONS}) через ${config.EMBEDDING_BASE_URL}`);
} else {
  log.warn("нет EMBEDDING_API_KEY/OPENROUTER_API_KEY: индексация выключена, поиск только по словам");
}

const isLocal = (url: string) => !/openrouter\.ai|api\.openai\.com/.test(url);

let ingestor: Ingestor | undefined;
let media: MediaProcessor | undefined;
if (config.telegramEnabled) {
  const client = createClient({
    apiId: config.TELEGRAM_API_ID!,
    apiHash: config.TELEGRAM_API_HASH!,
    session: config.TELEGRAM_SESSION!,
  });
  ingestor = new Ingestor(client, store, {
    backfillLimit: config.BACKFILL_LIMIT,
    pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
    onPosts: () => {
      indexer?.notify();
      media?.notify();
    },
  });
  const mediaOn = config.MEDIA_TYPES.length > 0 && (config.MEDIA_API_KEY || isLocal(config.MEDIA_BASE_URL));
  if (mediaOn) {
    const analyzer = createAnalyzer({ baseURL: config.MEDIA_BASE_URL, apiKey: config.MEDIA_API_KEY, model: config.MEDIA_MODEL });
    const source = ingestor;
    media = new MediaProcessor(store, analyzer, (channelId, messageId) => source.downloadMedia(channelId, messageId), {
      types: config.MEDIA_TYPES,
      since: config.mediaSince,
      maxBytes: config.MEDIA_MAX_MB * 1_048_576,
      maxSeconds: config.MEDIA_MAX_SECONDS,
      concurrency: config.MEDIA_CONCURRENCY,
      onDone: () => indexer?.notify(),
    });
    log.info(`медиа → текст: ${config.MEDIA_TYPES.join(", ")} моделью ${config.MEDIA_MODEL}`);
  } else if (config.MEDIA_TYPES.length > 0) {
    log.warn("нет MEDIA_API_KEY/OPENROUTER_API_KEY: фото, голосовые и кружки не разбираются");
  }
  ingestor
    .start(config.TELEGRAM_CHANNELS)
    .then(() => media?.start())
    .catch((error) => {
      log.error("Telegram не запустился — проверьте TELEGRAM_* и сессию (npm run login)", error);
      process.exit(1);
    });
} else {
  log.warn("Telegram выключен: нет TELEGRAM_API_ID/TELEGRAM_API_HASH/TELEGRAM_SESSION — отдаются только уже собранные посты");
}

const app = createApp({
  context: { store, embedder },
  mediaTypes: config.MEDIA_TYPES,
  ingestor,
  apiToken: config.API_TOKEN,
  adminToken: config.ADMIN_TOKEN,
  publicUrl: config.PUBLIC_URL,
});

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: "0.0.0.0" }, (info) =>
  log.info(`слушаю :${info.port} — MCP на /mcp, OpenAPI на /openapi.json`),
);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log.info(`${signal}: остановка`);
  indexer?.stop();
  media?.stop();
  server.close();
  await ingestor?.stop().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
