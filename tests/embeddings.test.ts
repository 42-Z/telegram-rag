import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEmbedder, type EmbedderConfig } from "../src/embeddings.ts";

interface RequestRecord {
  body: Record<string, unknown>;
  authorization: string | undefined;
}

const requests: RequestRecord[] = [];
let server: Server;
let endpoint: string;
let status = 200;
let statusQueue: number[] = [];
let retryAfter: string | undefined;
let delayMs = 0;
let invalidResponse = false;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function respond(response: ServerResponse, body: string, currentStatus: number): void {
  const currentRetryAfter = retryAfter;
  if (currentStatus !== 200) {
    response.writeHead(currentStatus, {
      "content-type": "application/json",
      ...(currentRetryAfter ? { "retry-after": currentRetryAfter } : {}),
    });
    response.end(JSON.stringify({ error: { message: "local test error" } }));
    return;
  }

  const input = (JSON.parse(body) as { input: unknown[] }).input;
  const vectors = input.map((_, index) => ({ index, embedding: [index + 0.1, 0.2, 0.3] }));
  if (invalidResponse) vectors[0] = { index: 0, embedding: [0.1, null, 0.3] } as never;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: vectors }));
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const raw = await readBody(request);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      response.writeHead(400).end();
      return;
    }
    requests.push({ body, authorization: request.headers.authorization });
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    respond(response, raw, statusQueue.shift() ?? status);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(() => {
  requests.length = 0;
  status = 200;
  statusQueue = [];
  retryAfter = undefined;
  delayMs = 0;
  invalidResponse = false;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function makeEmbedder(overrides: Partial<EmbedderConfig> = {}) {
  return createEmbedder({
    baseURL: endpoint,
    apiKey: "local-test-key",
    model: "google/gemini-embedding-2",
    dimensions: 3,
    sendDimensions: true,
    ...overrides,
  });
}

describe("multimodal embedding requests", () => {
  it("formats separate text queries and documents for retrieval", async () => {
    const embedder = makeEmbedder();
    const vectors = await embedder.embed([
      { type: "text", purpose: "query", text: "найди рецепт" },
      { type: "text", purpose: "document", title: "Кухня", text: "тесто для хлеба" },
    ]);

    expect(vectors).toEqual([[0.1, 0.2, 0.3], [1.1, 0.2, 0.3]]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe("Bearer local-test-key");
    expect(requests[0]?.body).toMatchObject({
      model: "google/gemini-embedding-2",
      input: [
        { content: [{ type: "text", text: "task: search result | query: найди рецепт" }] },
        { content: [{ type: "text", text: "title: Кухня | text: тесто для хлеба" }] },
      ],
      dimensions: 3,
      encoding_format: "float",
    });
  });

  it("keeps video and its aligned audio in one multimodal vector input", async () => {
    const embedder = makeEmbedder();
    await embedder.embed([{
      type: "multimodal",
      parts: [
        { type: "text", text: "подпись поста" },
        { type: "video", mimeType: "video/mp4", data: Buffer.from("video-bytes") },
        { type: "audio", mimeType: "audio/mpeg", data: Buffer.from("audio-bytes") },
      ],
    }]);

    const body = requests[0]?.body as { input: Array<{ content: Array<Record<string, unknown>> }> };
    expect(body.input).toHaveLength(1);
    expect(body.input[0]?.content.map((part) => part.type)).toEqual(["text", "input_video", "input_audio"]);
    expect(body.input[0]?.content[0]).toEqual({ type: "text", text: "подпись поста" });
    expect(body.input[0]?.content[1]?.input_video).toMatchObject({ format: "mp4" });
    expect(body.input[0]?.content[2]?.input_audio).toMatchObject({ format: "mp3" });
  });

  it("packs by serialized request size while preserving one vector per input", async () => {
    const embedder = makeEmbedder({ maxRequestBytes: 360 });
    const image = (marker: string) => ({
      type: "multimodal" as const,
      parts: [{ type: "image" as const, mimeType: "image/jpeg", data: Buffer.alloc(110, marker.charCodeAt(0)) }],
    });

    const vectors = await embedder.embed([image("a"), image("b")]);

    expect(requests.length).toBe(2);
    expect(vectors).toHaveLength(2);
    expect(requests.every((request) => Buffer.byteLength(JSON.stringify(request.body)) <= 360)).toBe(true);
  });

  it("retries rate limits, but does not retry non-retryable errors", async () => {
    statusQueue = [429];
    retryAfter = "0.001";
    const embedder = makeEmbedder();
    await expect(embedder.embed([{ type: "text", purpose: "query", text: "query" }])).resolves.toHaveLength(1);
    expect(requests).toHaveLength(2);

    requests.length = 0;
    status = 400;
    await expect(embedder.embed([{ type: "text", purpose: "query", text: "query" }])).rejects.toThrow("HTTP 400");
    expect(requests).toHaveLength(1);
  });

  it("times out and rejects malformed, non-finite, or wrong-sized vectors", async () => {
    delayMs = 30;
    const shortTimeout = makeEmbedder({ timeoutMs: 1 });
    await expect(shortTimeout.embed([{ type: "text", purpose: "query", text: "query" }])).rejects.toThrow(/failed/i);

    delayMs = 0;
    invalidResponse = true;
    const embedder = makeEmbedder();
    await expect(embedder.embed([{ type: "text", purpose: "query", text: "query" }])).rejects.toThrow(/non-numeric/);

    invalidResponse = false;
    status = 200;
    const wrongDimensions = makeEmbedder({ dimensions: 2 });
    await expect(wrongDimensions.embed([{ type: "text", purpose: "query", text: "query" }])).rejects.toThrow(/dimensions/);
  });

  it("rejects a single serialized input that exceeds the configured cap before sending it", async () => {
    const embedder = makeEmbedder({ maxRequestBytes: 128 });
    await expect(
      embedder.embed([{
        type: "multimodal",
        parts: [{ type: "image", mimeType: "image/jpeg", data: Buffer.alloc(512) }],
      }]),
    ).rejects.toThrow(/One embedding input exceeds/);
    expect(requests).toHaveLength(0);
  });
});
