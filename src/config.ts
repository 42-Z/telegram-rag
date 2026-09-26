/**
 * Настройки из переменных окружения. Всё, что зависит от площадки
 * развёртывания или от выбранной модели, живёт здесь, а не в коде.
 */

import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() !== "" ? value.trim() : undefined));

const list = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );

const schema = z.object({
  PORT: z.coerce.number().int().default(8000),
  /** Адрес сервиса снаружи — для OpenAPI и подсказок по подключению. */
  PUBLIC_URL: optional,

  /** postgres://… для боя, pglite://<папка> для локального запуска без Postgres. */
  DATABASE_URL: z.string().default("pglite://./data/pglite"),

  TELEGRAM_API_ID: z.coerce.number().int().optional(),
  TELEGRAM_API_HASH: optional,
  /** Строка сессии userbot'а, выдаётся `npm run login`. */
  TELEGRAM_SESSION: optional,
  /** Каналы, которые добавляются в пул при старте: @name, t.me/name, t.me/+invite. */
  TELEGRAM_CHANNELS: list,
  /** Сколько последних постов забрать из истории нового канала; 0 — всю историю. */
  BACKFILL_LIMIT: z.coerce.number().int().min(0).default(0),
  /** Догоняющий опрос каналов: страховка от пропущенных обновлений. */
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(300),

  /** Любой OpenAI-совместимый сервис эмбеддингов: OpenRouter, OpenAI, Ollama, vLLM… */
  EMBEDDING_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  EMBEDDING_API_KEY: optional,
  OPENROUTER_API_KEY: optional,
  EMBEDDING_MODEL: z.string().default("google/gemini-embedding-001"),
  /** Размер вектора. Смена модели или размера переиндексирует всё автоматически. */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(4000).default(1536),
  /** Передавать ли `dimensions` в запрос: не все модели его понимают. */
  EMBEDDING_SEND_DIMENSIONS: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(512).default(64),

  /**
   * Медиа → текст: какие типы разбирать мультимодальной моделью. Пусто —
   * выключено. Возможные: photo, voice, video_note, audio, video, gif.
   */
  MEDIA_TYPES: z
    .string()
    .default("photo,voice,video_note")
    .transform((value) => value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)),
  /** Любой OpenAI-совместимый сервис с моделью, понимающей изображения и звук. */
  MEDIA_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  MEDIA_API_KEY: optional,
  MEDIA_MODEL: z.string().default("google/gemini-3.5-flash-lite"),
  /** Разбирать медиа только постов не старше этой даты (ISO): история может стоить дорого. */
  MEDIA_SINCE: optional,
  MEDIA_MAX_MB: z.coerce.number().positive().default(20),
  MEDIA_MAX_SECONDS: z.coerce.number().int().positive().default(1800),
  MEDIA_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),

  /** Если задан — чтение знаний (MCP и API) только с `Authorization: Bearer <токен>`. */
  API_TOKEN: optional,
  /** Токен владельца: добавление и удаление каналов. Без него управление выключено. */
  ADMIN_TOKEN: optional,

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(env);
  return {
    ...parsed,
    EMBEDDING_API_KEY: parsed.EMBEDDING_API_KEY ?? parsed.OPENROUTER_API_KEY,
    MEDIA_API_KEY: parsed.MEDIA_API_KEY ?? parsed.OPENROUTER_API_KEY,
    mediaSince: parsed.MEDIA_SINCE ? new Date(parsed.MEDIA_SINCE) : undefined,
    telegramEnabled: Boolean(
      parsed.TELEGRAM_API_ID && parsed.TELEGRAM_API_HASH && parsed.TELEGRAM_SESSION,
    ),
  };
}
