/**
 * Прямые text/multimodal embeddings через OpenRouter-совместимый endpoint.
 * В запрос отправляется исходный текст и/или байты медиа; генерации анализа нет.
 */

export type EmbeddingPart =
  | { type: "text"; text: string }
  | { type: "image" | "audio" | "video"; mimeType: string; data: Uint8Array };

export type EmbeddingInput =
  | { type: "text"; purpose: "query" | "document"; text: string; title?: string }
  | { type: "multimodal"; parts: readonly EmbeddingPart[] };

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(inputs: readonly EmbeddingInput[]): Promise<number[][]>;
}

export interface EmbedderConfig {
  baseURL: string;
  apiKey: string | undefined;
  model: string;
  dimensions: number;
  sendDimensions: boolean;
  maxRequestBytes?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

function requestBody(config: EmbedderConfig, inputs: readonly EmbeddingInput[]): string {
  return JSON.stringify({
    model: config.model,
    input: inputs.map(toRequestInput),
    encoding_format: "float",
    ...(config.sendDimensions ? { dimensions: config.dimensions } : {}),
  });
}

function formatText(input: Extract<EmbeddingInput, { type: "text" }>): string {
  if (input.purpose === "query") return `task: search result | query: ${input.text}`;
  return `title: ${input.title?.trim() || "none"} | text: ${input.text}`;
}

function asDataUrl(data: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;
}

function audioFormat(mimeType: string): string {
  const subtype = mimeType.toLowerCase().split("/")[1]?.split(";")[0];
  if (subtype === "mpeg" || subtype === "mp3") return "mp3";
  if (subtype === "wav" || subtype === "x-wav") return "wav";
  throw new TypeError(`Unsupported audio embedding MIME type: ${mimeType}`);
}

function videoFormat(mimeType: string): string {
  const subtype = mimeType.toLowerCase().split("/")[1]?.split(";")[0];
  if (subtype === "mp4" || subtype === "quicktime") return subtype === "quicktime" ? "mov" : "mp4";
  throw new TypeError(`Unsupported video embedding MIME type: ${mimeType}`);
}

function toRequestInput(input: EmbeddingInput): string | { content: Array<Record<string, unknown>> } {
  if (input.type === "text") return formatText(input);
  if (input.parts.length === 0) throw new TypeError("A multimodal embedding input needs at least one content part");

  return {
    content: input.parts.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "image") {
        return { type: "image_url", image_url: { url: asDataUrl(part.data, part.mimeType) } };
      }
      if (part.type === "audio") {
        return {
          type: "input_audio",
          input_audio: { data: asDataUrl(part.data, part.mimeType), format: audioFormat(part.mimeType) },
        };
      }
      return {
        type: "input_video",
        input_video: { data: asDataUrl(part.data, part.mimeType), format: videoFormat(part.mimeType) },
      };
    }),
  };
}

interface EmbeddingResponse {
  data?: Array<{ index?: number; embedding?: unknown }>;
  error?: { message?: string };
}

function parseVectors(payload: unknown, count: number, dimensions: number, model: string): number[][] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as EmbeddingResponse).data)) {
    throw new Error("Embedding endpoint returned an invalid response body");
  }
  const data = (payload as EmbeddingResponse).data!;
  if (data.length !== count) throw new Error(`Embedding endpoint returned ${data.length} vectors for ${count} inputs`);

  const vectors = new Array<number[]>(count);
  for (const row of data) {
    if (!Number.isInteger(row.index) || row.index! < 0 || row.index! >= count || vectors[row.index!] !== undefined) {
      throw new Error("Embedding endpoint returned invalid or duplicate vector indexes");
    }
    if (!Array.isArray(row.embedding) || row.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error("Embedding endpoint returned a non-numeric vector");
    }
    if (row.embedding.length !== dimensions) {
      throw new Error(`Model ${model} returned ${row.embedding.length} dimensions; EMBEDDING_DIMENSIONS=${dimensions}`);
    }
    vectors[row.index!] = row.embedding as number[];
  }
  for (let index = 0; index < count; index += 1) {
    if (vectors[index] === undefined) throw new Error("Embedding endpoint omitted a vector index");
  }
  return vectors;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createEmbedder(config: EmbedderConfig): Embedder {
  const fetcher = config.fetch ?? fetch;
  const endpoint = `${config.baseURL.replace(/\/+$/, "")}/embeddings`;
  const maxBytes = config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/42-Z/telegram-rag",
    "X-Title": "telegram-rag",
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const request = async (inputs: readonly EmbeddingInput[]): Promise<number[][]> => {
    const body = requestBody(config, inputs);
    if (Buffer.byteLength(body) > maxBytes) {
      throw new Error(`Embedding request exceeds EMBEDDING_MAX_REQUEST_MB (${maxBytes} serialized bytes)`);
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) throw new Error(`Embedding request failed: ${error instanceof Error ? error.message : String(error)}`);
        await wait(250 * 2 ** (attempt - 1));
        continue;
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
          const retryAfter = Number(response.headers.get("retry-after"));
          await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5_000) : 250 * 2 ** (attempt - 1));
          continue;
        }
        throw new Error(`Embedding endpoint returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Embedding endpoint returned malformed JSON");
      }
      return parseVectors(payload, inputs.length, config.dimensions, config.model);
    }
    throw new Error("Embedding request exhausted retries");
  };

  return {
    model: config.model,
    dimensions: config.dimensions,
    async embed(inputs) {
      if (inputs.length === 0) return [];

      const batches: EmbeddingInput[][] = [];
      let batch: EmbeddingInput[] = [];
      for (const input of inputs) {
        if (Buffer.byteLength(requestBody(config, [input])) > maxBytes) {
          throw new Error(`One embedding input exceeds EMBEDDING_MAX_REQUEST_MB (${maxBytes} serialized bytes)`);
        }
        const candidate = [...batch, input];
        if (batch.length > 0 && Buffer.byteLength(requestBody(config, candidate)) > maxBytes) {
          batches.push(batch);
          batch = [input];
        } else batch = candidate;
      }
      if (batch.length > 0) batches.push(batch);

      const vectors: number[][] = [];
      for (const item of batches) vectors.push(...(await request(item)));
      return vectors;
    },
  };
}
