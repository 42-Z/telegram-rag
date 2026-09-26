/**
 * Эмбеддинги через любой OpenAI-совместимый интерфейс. По умолчанию —
 * OpenRouter (как в twitch-rag): официальный SDK OpenAI с другим базовым
 * адресом. Тот же код работает с OpenAI, Ollama (`http://ollama:11434/v1`),
 * vLLM, LM Studio и любым сервисом, повторяющим `/v1/embeddings`.
 */

import OpenAI from "openai";

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface EmbedderConfig {
  baseURL: string;
  apiKey: string | undefined;
  model: string;
  dimensions: number;
  sendDimensions: boolean;
}

export function createEmbedder(config: EmbedderConfig): Embedder {
  const client = new OpenAI({
    baseURL: config.baseURL,
    // Локальным серверам ключ не нужен, а SDK без него не создаётся.
    apiKey: config.apiKey ?? "not-needed",
    maxRetries: 4,
    defaultHeaders: { "HTTP-Referer": "https://github.com/42-Z/telegram-rag", "X-Title": "telegram-rag" },
  });

  return {
    model: config.model,
    dimensions: config.dimensions,
    async embed(texts) {
      if (texts.length === 0) return [];
      const response = await client.embeddings.create({
        model: config.model,
        input: [...texts],
        encoding_format: "float",
        ...(config.sendDimensions ? { dimensions: config.dimensions } : {}),
      });
      const vectors = [...response.data].sort((a, b) => a.index - b.index).map((item) => item.embedding as number[]);
      if (vectors.length !== texts.length) {
        throw new Error(`сервис эмбеддингов вернул ${vectors.length} векторов на ${texts.length} текстов`);
      }
      const wrong = vectors.find((vector) => vector.length !== config.dimensions);
      if (wrong) {
        throw new Error(
          `модель ${config.model} вернула вектор длиной ${wrong.length}, а EMBEDDING_DIMENSIONS=${config.dimensions}`,
        );
      }
      return vectors;
    },
  };
}
