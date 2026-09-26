## Взаимодействие

Общайся только на русском. По существу отвечай на вопрос, ни больше ни меньше.

## Описание проекта

telegram-rag — база знаний по Telegram-каналам для ЛЮБЫХ нейросетей. Userbot на
teleproto следит за пулом каналов, посты сохраняются целиком, эмбеддинги
(по умолчанию Gemini через OpenRouter) ложатся в Postgres/pgvector. Доступ —
MCP (`/mcp`), REST/OpenAPI и описания функций для function calling: всё
строится из одного реестра `src/tools.ts`. Новый инструмент добавляется только
туда — MCP, REST, OpenAPI и `/api/tools` подхватят его сами.

Устройство, подключение, запуск — README.md; сервер — deploy/README.md.

## Правила

- Node ≥ 24.12 исполняет TypeScript сам: только стираемый синтаксис (без `enum`,
  без свойств в параметрах конструктора), импорты — относительные с `.ts`.
- Проверяй методы teleproto по https://docs.teleproto.dev и по `.d.ts` в
  node_modules/teleproto, а не по памяти о GramJS: API разошлись (`client.updates`).
- Цифры (цены, размеры, лимиты) — только из документации или из ответа сервиса.
- Одна сессия Telegram — один процесс. Локально — своя сессия, не боевая.
- Изменения — в отдельной ветке с Pull Request; слияние в `main` выкатывает на VPS.

## Проверки

- `npm test` — без сети: PGlite с pgvector, подменённые эмбеддинги и клиент Telegram
- `npm run typecheck`

## Документация

- teleproto: https://docs.teleproto.dev
- MCP: https://modelcontextprotocol.io
- OpenRouter: https://openrouter.ai/llms.txt
- pgvector: https://github.com/pgvector/pgvector
- PGlite: https://pglite.dev
- Hono: https://hono.dev/llms.txt
