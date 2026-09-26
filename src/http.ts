/**
 * HTTP: MCP, REST, OpenAPI, описания функций и управление пулом.
 */

import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { handleMcp, SERVER_NAME, SERVER_VERSION } from "./mcp.ts";
import { logger } from "./log.ts";
import type { Ingestor } from "./telegram/ingest.ts";
import { TOOLS, ToolError, callTool, toolJsonSchema, type ToolContext } from "./tools.ts";

const log = logger("http");

export interface AppOptions {
  context: ToolContext;
  ingestor?: Ingestor;
  apiToken?: string;
  adminToken?: string;
  publicUrl?: string;
  mediaTypes?: readonly string[];
}

function tokenOf(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  // Не все клиенты MCP умеют заголовки — токен можно положить в адрес.
  return c.req.query("token") ?? c.req.header("x-api-key") ?? undefined;
}

function same(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

export function openApiDocument(baseUrl: string) {
  const paths: Record<string, unknown> = {};
  for (const tool of TOOLS) {
    paths[`/api/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.title,
        description: tool.description,
        requestBody: {
          required: false,
          content: { "application/json": { schema: toolJsonSchema(tool) } },
        },
        responses: {
          "200": { description: "Результат", content: { "application/json": { schema: { type: "object" } } } },
          "400": { description: "Неверные аргументы или нет такого канала/поста" },
          "401": { description: "Нужен токен" },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "telegram-rag",
      version: SERVER_VERSION,
      description: "Посты Telegram-каналов пула: поиск по смыслу и словам, лента, пост целиком.",
    },
    servers: [{ url: baseUrl }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    security: [{ bearer: [] }],
    paths,
  };
}

/** Описания функций в форматах популярных API — чтобы подключить любую модель. */
export function functionDeclarations(format: string) {
  const tools = TOOLS.map((tool) => ({ name: tool.name, description: tool.description, schema: toolJsonSchema(tool) }));
  switch (format) {
    case "anthropic":
      return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
    case "gemini":
      return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.schema })) }];
    default:
      // OpenAI Chat Completions — его же понимают OpenRouter, Mistral, Groq, DeepSeek, Ollama, vLLM и др.
      return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
  }
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const { context, ingestor } = options;

  app.onError((error, c) => {
    if (error instanceof ToolError) return c.json({ error: error.message }, 400);
    log.error(`${c.req.method} ${c.req.path}`, error);
    return c.json({ error: "внутренняя ошибка" }, 500);
  });

  const baseUrl = (c: Context) => options.publicUrl ?? new URL(c.req.url).origin;

  const readAuth = async (c: Context, next: () => Promise<void>) => {
    if (options.apiToken && !same(tokenOf(c), options.apiToken)) return c.json({ error: "нужен токен" }, 401);
    await next();
  };
  const adminAuth = async (c: Context, next: () => Promise<void>) => {
    if (!options.adminToken) return c.json({ error: "управление выключено: не задан ADMIN_TOKEN" }, 403);
    if (!same(tokenOf(c), options.adminToken)) return c.json({ error: "нужен токен владельца" }, 401);
    if (!ingestor) return c.json({ error: "Telegram не подключён: нет TELEGRAM_SESSION" }, 503);
    await next();
  };

  app.get("/health", async (c) =>
    c.json({
      ok: true,
      telegram: Boolean(ingestor),
      index: await context.store.indexStats(),
      media: await context.store.mediaStats(options.mediaTypes ?? []),
    }),
  );

  app.get("/", (c) => {
    const url = baseUrl(c);
    return c.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      about: "База знаний по постам Telegram-каналов для любых нейросетей",
      connect: {
        mcp: `${url}/mcp`,
        openapi: `${url}/openapi.json`,
        function_calling: {
          openai: `${url}/api/tools`,
          anthropic: `${url}/api/tools?format=anthropic`,
          gemini: `${url}/api/tools?format=gemini`,
          call: `POST ${url}/api/tools/<name> с аргументами в теле`,
        },
      },
      auth: options.apiToken ? "Authorization: Bearer <API_TOKEN> или ?token=<API_TOKEN>" : "не требуется",
      tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description })),
    });
  });

  app.all("/mcp", readAuth, (c) => handleMcp(c.req.raw, context));

  app.get("/openapi.json", (c) => c.json(openApiDocument(baseUrl(c))));

  app.get("/api/tools", readAuth, (c) => c.json(functionDeclarations(c.req.query("format") ?? "openai")));

  app.post("/api/tools/:name", readAuth, async (c) => {
    const name = c.req.param("name") ?? "";
    return c.json((await callTool(name, await jsonBody(c), context)) as object);
  });

  /** Короткий путь для людей и curl: /api/search?q=…&channels=@a,@b&limit=5 */
  app.get("/api/search", readAuth, async (c) => {
    const channels = c.req.query("channels")?.split(",").filter(Boolean);
    const limit = c.req.query("limit");
    const result = await callTool(
      "search_posts",
      {
        query: c.req.query("q") ?? "",
        channels,
        date_from: c.req.query("from"),
        date_to: c.req.query("to"),
        mode: c.req.query("mode"),
        limit: limit ? Number(limit) : undefined,
      },
      context,
    );
    return c.json(result as object);
  });

  // ── управление пулом ────────────────────────────────────────────────────

  app.get("/api/admin/channels", adminAuth, async (c) =>
    c.json({
      channels: await context.store.listChannels({ includeDisabled: true }),
      index: await context.store.indexStats(),
      media: await context.store.mediaStats(options.mediaTypes ?? []),
    }),
  );

  app.post("/api/admin/channels", adminAuth, async (c) => {
    const body = (await jsonBody(c)) as { ref?: string; refs?: string[] };
    const refs = body.refs ?? (body.ref ? [body.ref] : []);
    if (refs.length === 0) return c.json({ error: "нужно { ref: \"@channel\" } или { refs: [...] }" }, 400);
    const added = [];
    const failed = [];
    for (const ref of refs) {
      try {
        added.push(await ingestor!.addChannel(ref));
      } catch (error) {
        failed.push({ ref, error: String(error instanceof Error ? error.message : error) });
      }
    }
    return c.json({ added, failed }, failed.length > 0 && added.length === 0 ? 400 : 200);
  });

  app.delete("/api/admin/channels/:ref", adminAuth, async (c) => {
    const channel = await context.store.findChannel(decodeURIComponent(c.req.param("ref") ?? ""));
    if (!channel) return c.json({ error: "нет такого канала" }, 404);
    const purge = c.req.query("purge") === "1" || c.req.query("purge") === "true";
    await ingestor!.removeChannel(channel, purge);
    return c.json({ removed: channel.title, purged: purge });
  });

  app.post("/api/admin/sync", adminAuth, async (c) => {
    void ingestor!.syncAll();
    return c.json({ started: true });
  });

  app.post("/api/admin/retry-failed", adminAuth, async (c) => {
    await context.store.retryEmbedErrors();
    return c.json({ ok: true });
  });

  return app;
}
