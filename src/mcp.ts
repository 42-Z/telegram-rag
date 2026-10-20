/**
 * MCP-сервер: те же инструменты, что и в REST. Транспорт — Streamable HTTP
 * без сессий: на каждый запрос новый сервер, состояние живёт в базе.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { collectMediaResourceLinks } from "./presentation.ts";
import { TOOLS, ToolError, callTool, type ToolContext } from "./tools.ts";

export const SERVER_NAME = "telegram-rag";
export const SERVER_VERSION = "0.1.0-beta";

const INSTRUCTIONS =
  "База знаний по постам Telegram-каналов. Начни с list_channels, чтобы увидеть пул. " +
  "search_posts — поиск по смыслу и словам по каналам пула; list_posts — короткая лента одного канала по @имени " +
  "или ссылке, в том числе канала вне пула, с датами, offset и фильтром media_types для документов, стикеров и " +
  "других вложений; get_post — пост целиком с альбомом, контекстом, просмотрами и реакциями. " +
  "Каналы вне пула не участвуют в поиске, их вложения не архивируются, а кэш удаляется через время. " +
  "Текст поста отдаётся вместе с прямыми временными ссылками на оригиналы медиа. " +
  "Отвечая, ссылайся на посты по полю link.";

export function createMcpServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input.shape,
        annotations: { readOnlyHint: tool.readOnly ?? true, openWorldHint: false },
      },
      async (args: unknown) => {
        try {
          const result = await callTool(tool.name, args, context);
          const content = [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ...collectMediaResourceLinks(result),
          ];
          const structuredContent = result && typeof result === "object" && !Array.isArray(result)
            ? result as Record<string, unknown>
            : undefined;
          return { content, structuredContent };
        } catch (error) {
          const message = error instanceof ToolError ? error.message : `внутренняя ошибка: ${String(error)}`;
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
      },
    );
  }
  return server;
}

export async function handleMcp(request: Request, context: ToolContext): Promise<Response> {
  const server = createMcpServer(context);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Ответ уже собран целиком (enableJsonResponse): сервер можно отпускать.
    void server.close();
  }
}
