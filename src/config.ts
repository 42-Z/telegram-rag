/**
 * Настройки из переменных окружения. Всё, что зависит от площадки
 * развёртывания или от выбранной модели, живёт здесь, а не в коде.
 */

import { isIP } from "node:net";
import { z } from "zod";
import { MODALITIES, type EmbeddingApi, type Modality } from "./embeddings.ts";
import { MEDIA_ARCHIVE_MAX_BYTES, MEDIA_EMBED_MAX_BYTES, MEDIA_EMBED_MAX_SECONDS } from "./media/limits.ts";

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

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MODEL = "google/gemini-embedding-2";
const OPENROUTER_DEFAULT_DIMENSIONS = 1536;
/** Ollama отвергает `input.video`, у OpenRouter видео принимает мультимодальная модель. */
const DEFAULT_MODALITIES: Record<EmbeddingApi, readonly Modality[]> = {
  openrouter: ["image", "audio", "video"],
  ollama: ["image", "audio"],
};

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "localhost." || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

const httpUrl = optional.pipe(
  z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      const secureTransport = url.protocol === "https:" ||
        (url.protocol === "http:" && isLoopbackHostname(url.hostname));
      return secureTransport && !url.username && !url.password && !url.search && !url.hash;
    }, {
      message: "S3_ENDPOINT must use HTTPS for non-loopback hosts and must not contain credentials or query parameters",
    })
    .optional(),
);

const embeddingBaseUrl = optional.pipe(z.string().url().optional());

const embeddingDimensions = optional
  .transform((value) => (value === undefined ? undefined : Number(value)))
  .pipe(z.number().int().min(1).max(4000).optional());

const embeddingModalities = optional
  .transform((value) => value?.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean))
  .pipe(z.array(z.enum(MODALITIES)).min(1).optional());

const schema = z.object({
  PORT: z.coerce.number().int().default(8000),
  /** Адрес сервиса снаружи — для OpenAPI и подсказок по подключению. */
  PUBLIC_URL: optional,

  /**
   * postgres://… — облачная база (Supabase, Neon) или свой Postgres с pgvector;
   * pglite://<папка> — локальный запуск без Postgres.
   */
  DATABASE_URL: z.string().default("pglite://./data/pglite"),
  /** Корневой сертификат базы (PEM целиком или путь к файлу) — нужен для Supabase. */
  DATABASE_CA_CERT: optional,
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(5),

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

  /**
   * Эмбеддинги — только мультимодальные модели. Бэкенд выбирают переменные:
   * `OPENROUTER_API_KEY` — OpenRouter; `EMBEDDING_BASE_URL` — Ollama (нативный
   * `/api/embed`, ключ нужен только за прокси или для Ollama Cloud). Одно из двух
   * обязательно, оба сразу — ошибка.
   */
  OPENROUTER_API_KEY: optional,
  EMBEDDING_BASE_URL: embeddingBaseUrl,
  EMBEDDING_API_KEY: optional,
  /** Для OpenRouter по умолчанию google/gemini-embedding-2; для Ollama обязательна. */
  EMBEDDING_MODEL: optional,
  /**
   * Размер вектора (OpenRouter по умолчанию 1536; для Ollama обязателен). Смена модели
   * или размера переиндексирует всё автоматически.
   */
  EMBEDDING_DIMENSIONS: embeddingDimensions,
  /**
   * Какие типы медиа умеет модель: image, audio, video. Текст поддерживается всегда.
   * По умолчанию OpenRouter — все три, Ollama — image и audio. Медиа остальных типов
   * сохраняется в S3 и отдаётся вместе с постом, но не получает вектор.
   */
  EMBEDDING_MODALITIES: embeddingModalities,
  /** Передавать ли `dimensions` в запрос: не все модели его понимают. */
  EMBEDDING_SEND_DIMENSIONS: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(512).default(64),
  /** Верхняя граница сериализованного JSON-запроса с base64-медиа. */
  EMBEDDING_MAX_REQUEST_MB: z.coerce.number().int().min(1).max(512).default(32),

  /**
   * Устарела: оригиналы всех типов вложений сохраняются в S3, а векторы строятся для
   * тех, что поддерживает модель (`EMBEDDING_MODALITIES`). Значение отвергается, чтобы
   * старый `.env` не менял поведение молча.
   */
  MEDIA_TYPES: optional,
  /** Архивировать все медиа; мультимодальные векторы строятся только после этой даты. */
  MEDIA_SINCE: optional,
  /**
   * Устарели: пределы зафиксированы в `src/media/limits.ts` (2048 МиБ по
   * прямому запросу, 100 МиБ для фоновой индексации и векторного поиска,
   * 1800 секунд). Значения отвергаются, чтобы старый `.env` не менял
   * поведение молча.
   */
  MEDIA_MAX_MB: optional,
  MEDIA_MAX_SECONDS: optional,
  MEDIA_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  MEDIA_SEGMENT_SECONDS: z.coerce.number().int().min(1).max(120).default(60),
  MEDIA_SEGMENT_OVERLAP_SECONDS: z.coerce.number().int().min(0).max(119).default(5),

  /** S3-compatible хранилище оригиналов медиа. Endpoint не нужен для AWS S3. */
  S3_ENDPOINT: httpUrl,
  S3_REGION: optional,
  S3_BUCKET: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  S3_SESSION_TOKEN: optional,
  /** Expiry of static temporary S3 credentials; required together with S3_SESSION_TOKEN. */
  S3_CREDENTIALS_EXPIRES_AT: optional.refine(
    (value) => value === undefined || (Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()),
    { message: "S3_CREDENTIALS_EXPIRES_AT must be a future date/time" },
  ),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  S3_URL_TTL_SECONDS: z.coerce.number().int().min(1).max(604_800).default(3600),

  /** Если задан — чтение знаний (MCP и API) только с `Authorization: Bearer <токен>`. */
  API_TOKEN: optional,
  /** Токен владельца: добавление и удаление каналов. Без него управление выключено. */
  ADMIN_TOKEN: optional,

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
}).superRefine((config, ctx) => {
  const ollama = config.EMBEDDING_BASE_URL !== undefined;
  if (ollama && config.OPENROUTER_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["EMBEDDING_BASE_URL"],
      message: "EMBEDDING_BASE_URL (Ollama) and OPENROUTER_API_KEY (OpenRouter) are mutually exclusive; set only one",
    });
  } else if (!ollama && !config.OPENROUTER_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["OPENROUTER_API_KEY"],
      message: "A multimodal embedding backend is required: set OPENROUTER_API_KEY (OpenRouter) or EMBEDDING_BASE_URL (Ollama)",
    });
  }
  if (!ollama && config.EMBEDDING_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["EMBEDDING_API_KEY"],
      message: "EMBEDDING_API_KEY is only used together with EMBEDDING_BASE_URL (Ollama); OpenRouter reads OPENROUTER_API_KEY",
    });
  }
  if (ollama) {
    for (const key of ["EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS"] as const) {
      if (config[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: `${key} is required with EMBEDDING_BASE_URL (Ollama)` });
      }
    }
    if (config.EMBEDDING_MODALITIES?.includes("video")) {
      ctx.addIssue({
        code: "custom",
        path: ["EMBEDDING_MODALITIES"],
        message: "Ollama does not accept video input; use image and/or audio",
      });
    }
  }

  if (config.MEDIA_TYPES !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["MEDIA_TYPES"],
      message: "MEDIA_TYPES is no longer used: all media is stored in S3, and vectors are built for the types the model accepts (EMBEDDING_MODALITIES). Remove it",
    });
  }
  for (const key of ["MEDIA_MAX_MB", "MEDIA_MAX_SECONDS"] as const) {
    if (config[key] !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is no longer configurable: originals are archived up to ${MEDIA_ARCHIVE_MAX_BYTES / 1_048_576} MiB, vector search accepts up to ${MEDIA_EMBED_MAX_BYTES / 1_048_576} MiB and ${MEDIA_EMBED_MAX_SECONDS} seconds. Remove it`,
      });
    }
  }
  if (config.MEDIA_SEGMENT_OVERLAP_SECONDS >= config.MEDIA_SEGMENT_SECONDS) {
    ctx.addIssue({
      code: "custom",
      path: ["MEDIA_SEGMENT_OVERLAP_SECONDS"],
      message: "MEDIA_SEGMENT_OVERLAP_SECONDS must be smaller than MEDIA_SEGMENT_SECONDS",
    });
  }
  if (config.S3_SESSION_TOKEN && !config.S3_CREDENTIALS_EXPIRES_AT) {
    ctx.addIssue({
      code: "custom",
      path: ["S3_CREDENTIALS_EXPIRES_AT"],
      message: "S3_CREDENTIALS_EXPIRES_AT is required when S3_SESSION_TOKEN is set",
    });
  }

  const required = [
    "S3_REGION",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ] as const;
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["S3_BUCKET"],
      message: `S3 is required for the media archive; configure ${missing.join(", ")}. S3_ENDPOINT is optional.`,
    });
  }
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(env);
  const api: EmbeddingApi = parsed.EMBEDDING_BASE_URL ? "ollama" : "openrouter";
  return {
    ...parsed,
    /** Выбранный бэкенд эмбеддингов со всеми умолчаниями; поля `EMBEDDING_*` выше — сырые значения. */
    embedding: {
      api,
      baseURL: parsed.EMBEDDING_BASE_URL ?? OPENROUTER_BASE_URL,
      apiKey: api === "ollama" ? parsed.EMBEDDING_API_KEY : parsed.OPENROUTER_API_KEY,
      model: parsed.EMBEDDING_MODEL ?? OPENROUTER_DEFAULT_MODEL,
      dimensions: parsed.EMBEDDING_DIMENSIONS ?? OPENROUTER_DEFAULT_DIMENSIONS,
      sendDimensions: parsed.EMBEDDING_SEND_DIMENSIONS,
      maxRequestBytes: parsed.EMBEDDING_MAX_REQUEST_MB * 1_048_576,
      modalities: parsed.EMBEDDING_MODALITIES ?? [...DEFAULT_MODALITIES[api]],
    },
    mediaSince: parsed.MEDIA_SINCE ? new Date(parsed.MEDIA_SINCE) : undefined,
    telegramEnabled: Boolean(
      parsed.TELEGRAM_API_ID && parsed.TELEGRAM_API_HASH && parsed.TELEGRAM_SESSION,
    ),
  };
}
