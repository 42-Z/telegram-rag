/**
 * Сервис целиком без сети: PGlite с pgvector, предсказуемые эмбеддинги,
 * настоящие HTTP-запросы в приложение и настоящий MCP-клиент.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db.ts";
import { createApp } from "../src/http.ts";
import { Indexer } from "../src/indexer.ts";
import { normalizeMessage } from "../src/telegram/normalize.ts";
import { DIMENSIONS, fakeEmbedder, freshStore, message, seed } from "./helpers.ts";

const { db, store } = await freshStore();
const embedder = fakeEmbedder();
const indexer = new Indexer(store, embedder, 64);
const app = createApp({ context: { store, embedder }, apiToken: "secret", publicUrl: "http://test" });

const call = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { authorization: "Bearer secret", "content-type": "application/json", ...init.headers } });
const tool = async (name: string, args: unknown) => {
  const response = await call(`/api/tools/${name}`, { method: "POST", body: JSON.stringify(args) });
  return { status: response.status, body: (await response.json()) as any };
};

beforeAll(async () => {
  await seed(store);
  while ((await indexer.runOnce()) > 0);
});
afterAll(() => db.close());

describe("индексация", () => {
  it("индексирует всё, где есть текст, и не трогает неизменённое", async () => {
    const stats = await store.indexStats();
    expect(stats).toMatchObject({ posts: 6, indexed: 6, pending: 0, failed: 0 });
    // пост без текста (фото из альбома) проиндексирован без кусков
    expect(stats.chunks).toBe(5);

    const calls = embedder.calls;
    await store.upsertPosts([normalizeMessage(1001, message(1, "Вышла новая видеокарта с огромной производительностью в играх", { views: 999 }))]);
    expect(await indexer.runOnce()).toBe(0);
    expect(embedder.calls).toBe(calls);
  });

  it("правка поста переиндексирует его", async () => {
    await store.upsertPosts([normalizeMessage(1002, message(2, "Как испечь хлеб на закваске дома. Обновлено: ржаная мука"))]);
    expect((await store.indexStats()).pending).toBe(1);
    expect(await indexer.runOnce()).toBe(1);
    expect((await store.indexStats()).pending).toBe(0);
  });

  it("смена модели переиндексирует всё", async () => {
    await migrate(db, { model: "fake-2", dimensions: DIMENSIONS });
    expect((await store.indexStats()).pending).toBe(6);
    while ((await indexer.runOnce()) > 0);
    expect((await store.indexStats()).indexed).toBe(6);
  });
});

describe("REST", () => {
  it("без токена — 401", async () => {
    expect((await app.request("/api/tools/list_channels", { method: "POST" })).status).toBe(401);
  });

  it("list_channels", async () => {
    const { body } = await tool("list_channels", {});
    expect(body.channels.map((c: any) => c.title)).toEqual(["Tech News", "Кулинария"]);
    expect(body.channels[0]).toMatchObject({ username: "tech", posts: 4, indexed: 4 });
  });

  it("search_posts находит по смыслу и по словам", async () => {
    const { body } = await tool("search_posts", { query: "рецепт борща со свёклой" });
    expect(body.mode).toBe("hybrid");
    expect(body.results[0]).toMatchObject({ channel: "Кулинария", message_id: 1, link: "https://t.me/food/1" });

    const keyword = await tool("search_posts", { query: "смартфона", mode: "keyword" });
    expect(keyword.body.results[0].text).toContain("смартфона");

    // русская морфология: «видеокарты» находит «видеокарта»
    const morph = await tool("search_posts", { query: "видеокарты", mode: "keyword" });
    expect(morph.body.results[0]?.message_id).toBe(1);
  });

  it("фильтр по каналу и датам", async () => {
    const { body } = await tool("search_posts", { query: "хлеб", channels: ["@tech"] });
    expect(body.results.every((r: any) => r.channel === "Tech News")).toBe(true);

    const none = await tool("list_posts", { date_to: "2020-01-01" });
    expect(none.body.total).toBe(0);

    const unknown = await tool("search_posts", { query: "x", channels: ["@nope"] });
    expect(unknown.status).toBe(400);
  });

  it("list_posts сворачивает альбом и листается", async () => {
    const { body } = await tool("list_posts", { channels: ["tech"], order: "oldest" });
    expect(body.total).toBe(4);
    expect(body.posts).toHaveLength(3);
    expect(body.posts[2]).toMatchObject({ text: "Фото с презентации процессоров" });
    expect(body.posts[2].album).toHaveLength(2);

    const page = await tool("list_posts", { limit: 2, offset: 0 });
    expect(page.body.next_offset).toBe(2);
  });

  it("get_post по ссылке — с альбомом и соседями", async () => {
    const { body } = await tool("get_post", { link: "https://t.me/tech/3", context: 1 });
    expect(body.text).toBe("Фото с презентации процессоров");
    expect(body.album).toHaveLength(2);
    expect(body.before).toHaveLength(1);
    expect(body.before[0].message_id).toBe(2);

    const missing = await tool("get_post", { channel: "tech", message_id: 999 });
    expect(missing.status).toBe(400);
  });

  it("неверные аргументы — понятная ошибка", async () => {
    const { status, body } = await tool("search_posts", { limit: 5 });
    expect(status).toBe(400);
    expect(body.error).toContain("query");
  });

  it("/api/search для людей", async () => {
    const response = await call("/api/search?q=хлеб&limit=1");
    const body = (await response.json()) as any;
    expect(body.results).toHaveLength(1);
  });
});

describe("подключение любых моделей", () => {
  it("описания функций в трёх форматах", async () => {
    const openai = (await (await call("/api/tools")).json()) as any[];
    expect(openai.map((t) => t.function.name)).toEqual(["list_channels", "search_posts", "get_post", "list_posts"]);
    expect(openai[1].function.parameters).toMatchObject({ type: "object", required: ["query"] });

    const anthropic = (await (await call("/api/tools?format=anthropic")).json()) as any[];
    expect(anthropic[1].input_schema.properties.query.type).toBe("string");

    const gemini = (await (await call("/api/tools?format=gemini")).json()) as any[];
    expect(gemini[0].functionDeclarations).toHaveLength(4);
  });

  it("OpenAPI", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as any;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("http://test");
    expect(Object.keys(doc.paths)).toContain("/api/tools/search_posts");
  });

  it("MCP: настоящий клиент видит инструменты и вызывает их", async () => {
    const transport = new StreamableHTTPClientTransport(new URL("http://test/mcp"), {
      requestInit: { headers: { authorization: "Bearer secret" } },
      fetch: async (url, init) => app.request(String(url), init as RequestInit),
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_channels", "search_posts", "get_post", "list_posts"]);
    expect(tools[1]!.annotations?.readOnlyHint).toBe(true);

    const result = (await client.callTool({ name: "search_posts", arguments: { query: "хлеб на закваске", limit: 2 } })) as any;
    const payload = JSON.parse(result.content[0].text);
    expect(payload.results[0].link).toBe("https://t.me/food/2");

    const error = (await client.callTool({ name: "get_post", arguments: { link: "мусор" } })) as any;
    expect(error.isError).toBe(true);
    await client.close();
  });
});

describe("без эмбеддингов", () => {
  it("поиск откатывается на слова и говорит об этом", async () => {
    const bare = createApp({ context: { store, embedder: undefined } });
    const response = await bare.request("/api/tools/search_posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "борщ" }),
    });
    const body = (await response.json()) as any;
    expect(body.mode).toBe("keyword");
    expect(body.notice).toBeTruthy();
  });
});
