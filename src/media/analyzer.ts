/**
 * Медиа → текст одной мультимодальной моделью через любой OpenAI-совместимый
 * API. По умолчанию — Gemini через OpenRouter: одна модель слушает звук и
 * смотрит картинки, отдельный сервис распознавания речи не нужен.
 *
 * Звук уходит частью `input_audio` (base64, mp3), изображения — `image_url`
 * с data-URL. Ответ — по строгой схеме JSON.
 */

import OpenAI from "openai";
import type { MediaAnalysis } from "../store.ts";

export interface MediaInput {
  /** photo, voice, audio, video_note, video… */
  type: string;
  images: Buffer[];
  audio: Buffer | null;
  /** Подпись поста — помогает модели с именами и терминами. */
  caption: string;
  channelTitle?: string;
}

export interface MediaAnalyzer {
  readonly model: string;
  analyze(input: MediaInput): Promise<MediaAnalysis>;
}

export interface AnalyzerConfig {
  baseURL: string;
  apiKey: string | undefined;
  model: string;
}

export const SYSTEM_PROMPT = `Ты превращаешь медиа из постов Telegram-канала в текст для базы знаний: по нему пост будут искать и по нему нейросеть будет отвечать на вопросы вместо того, кто медиа не видел и не слышал.

Верни JSON с тремя полями, пустая строка — если заполнить нечем:
- transcript — дословная расшифровка всей речи на языке оригинала: без пересказа, сокращений и исправления смысла. Разбивай на абзацы по паузам и сменам темы. Если говорят несколько человек — помечай смену говорящего («— »). Неразборчивое — [неразборчиво]. Музыку и шум не описывай здесь.
- description — на русском, что изображено или происходит: люди, их действия и эмоции, объекты, место, обстановка, графики и схемы (что они показывают), мемы (в чём шутка). Конкретно и с деталями, которые могут понадобиться при поиске; 1–6 предложений. Для чистого аудио — только характер записи (голос, музыка, фон), одним предложением.
- text_on_image — весь видимый текст дословно, на языке оригинала: надписи, скриншоты, слайды, подписи, таблицы (строками). Для нескольких кадров — без повторов.

Ничего не выдумывай: чего не видно и не слышно — того нет.`;

const RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "media_analysis",
    strict: true,
    schema: {
      type: "object",
      properties: {
        transcript: { type: "string" },
        description: { type: "string" },
        text_on_image: { type: "string" },
      },
      required: ["transcript", "description", "text_on_image"],
      additionalProperties: false,
    },
  },
};

const KIND: Record<string, string> = {
  photo: "фотография",
  voice: "голосовое сообщение",
  audio: "аудиозапись",
  video_note: "видеосообщение-кружок (звук и кадры из него)",
  video: "видео (звук и кадры из него)",
  gif: "анимация (кадры из неё)",
};

export function buildUserContent(input: MediaInput): OpenAI.Chat.ChatCompletionContentPart[] {
  const intro = [
    `Медиа: ${KIND[input.type] ?? input.type}.`,
    input.channelTitle ? `Канал: ${input.channelTitle}.` : "",
    input.caption ? `Подпись поста (для контекста, не расшифровывать):\n${input.caption.slice(0, 2000)}` : "Подписи нет.",
  ]
    .filter(Boolean)
    .join("\n");
  const parts: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: "text", text: intro }];
  for (const image of input.images) {
    parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}` } });
  }
  if (input.audio) {
    parts.push({ type: "input_audio", input_audio: { data: input.audio.toString("base64"), format: "mp3" } });
  }
  return parts;
}

export function parseAnalysis(content: string, model: string): MediaAnalysis {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    const data = JSON.parse(cleaned) as Record<string, unknown>;
    const pick = (key: string) => (typeof data[key] === "string" && data[key].trim() ? data[key].trim() : undefined);
    return { transcript: pick("transcript"), description: pick("description"), textOnImage: pick("text_on_image"), model };
  } catch {
    // Модель ответила не по схеме — текст всё равно полезен для поиска.
    return { description: cleaned || undefined, model };
  }
}

export function createAnalyzer(config: AnalyzerConfig): MediaAnalyzer {
  const client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey ?? "not-needed",
    maxRetries: 3,
    timeout: 180_000,
    defaultHeaders: { "HTTP-Referer": "https://github.com/42-Z/telegram-rag", "X-Title": "telegram-rag" },
  });
  return {
    model: config.model,
    async analyze(input) {
      const response = await client.chat.completions.create({
        model: config.model,
        temperature: 0,
        response_format: RESPONSE_FORMAT,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserContent(input) },
        ],
      });
      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error(`модель ${config.model} вернула пустой ответ`);
      return parseAnalysis(content, config.model);
    },
  };
}

const clock = (seconds: number | undefined) => {
  if (!seconds) return "";
  const s = Math.round(seconds);
  return `, ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const LABEL: Record<string, string> = {
  photo: "Фото",
  voice: "Голосовое сообщение",
  audio: "Аудио",
  video_note: "Кружок",
  video: "Видео",
  gif: "GIF",
};

/** Разбор медиа одним текстом — для поиска по словам и эмбеддингов. */
export function mediaText(type: string, duration: number | undefined, analysis: MediaAnalysis): string | null {
  const parts = [
    analysis.transcript ? `Расшифровка: ${analysis.transcript}` : "",
    analysis.description ? `Описание: ${analysis.description}` : "",
    analysis.textOnImage ? `Текст на изображении: ${analysis.textOnImage}` : "",
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return `[${LABEL[type] ?? type}${clock(duration)}]\n${parts.join("\n")}`;
}
