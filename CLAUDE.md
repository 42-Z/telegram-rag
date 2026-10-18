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
- Изменения — в отдельной ветке с Pull Request; в `main` — только с зелёным CI.
  На VPS выкатывает вручную workflow Deploy, слияние в `main` само ничего не выкатывает.
- Не опирайся лишь на описания и комментарии, проверяй как все устроено на самом деле

## Проверки

- `npm test` — без сети: PGlite с pgvector, подменённые эмбеддинги и клиент Telegram;
  нужен настоящий ffmpeg (tests/media.test.ts)
- `npm run typecheck`

## CI и выкатка

- `.github/workflows/ci.yml` — typecheck и тесты на каждом PR и пуше в `main`.
  Новую проверку добавляй сюда: Deploy вызывает этот же файл.
- `.github/workflows/deploy.yml` — только вручную (Actions → Deploy), только из `main`:
  CI → образ в GHCR → SSH и `deploy/deploy.sh` с откатом → проверка адреса снаружи.
  Автовыкатки на пуш нет: секреты и окружение `production` в репозитории не заведены.
- Экшены закреплены на SHA с версией в комментарии, обновляет Dependabot
  (`.github/dependabot.yml`). Новый экшен — тоже на SHA.
- Секреты и недоверенные значения передавай в `run` через `env`, не подстановкой `${{ }}`.
- После правки workflow'ов: `uvx --with shellcheck-py --from actionlint-py actionlint`.

## Документация

- teleproto: https://docs.teleproto.dev
- MCP: https://modelcontextprotocol.io
- OpenRouter: https://openrouter.ai/llms.txt
- pgvector: https://github.com/pgvector/pgvector
- PGlite: https://pglite.dev
- Hono: https://hono.dev/llms.txt
