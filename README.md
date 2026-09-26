# telegram-rag

> **Бета.** Работает на живых каналах, но интерфейс инструментов и схема
> базы ещё могут меняться. Выкатка на сервер — вручную.

База знаний по Telegram-каналам для любых нейросетей. Сервис через userbot
(teleproto) постоянно следит за пулом каналов, сохраняет каждый пост целиком,
строит эмбеддинги и отдаёт посты ассистентам: через MCP, REST/OpenAPI и
готовые описания функций для function calling.

Младший брат [twitch-rag](https://github.com/42-Z/twitch-rag): тот же принцип
(знания → векторы → MCP), только вместо записей эфиров — посты каналов.

## Как это работает

```
Telegram (MTProto)                telegram-rag (один процесс)                  Postgres + pgvector (Supabase/Neon)
──────────────────               ─────────────────────────────                ───────────────────
история канала      ──────────▶  Ingestor: история → живые обновления  ─────▶  channels
новые посты, правки,             → догоняющий опрос раз в 5 минут              posts (целиком: текст,
  удаления (watch)                                                              медиа, альбомы, реакции,
фото, голосовые,    ──────────▶  MediaProcessor: ffmpeg → Gemini       ─────▶   пересылки, просмотры,
  кружки                           (расшифровка, описание, OCR)                 расшифровки и описания)
                                 Indexer: куски → эмбеддинги пачками  ─────▶
                                   (OpenRouter · Gemini, или любой              chunks (векторы, HNSW)
                                    OpenAI-совместимый сервис)                  + полнотекстовый индекс

любая нейросеть     ◀──────────  /mcp · /api/tools/* · /openapi.json · /api/tools (function calling)
```

- **История.** При добавлении канала читается вся история (или последние
  `BACKFILL_LIMIT` постов) от старых к новым, с отметкой прогресса: после
  перезапуска чтение продолжается с места остановки.
- **Живые обновления.** `client.updates.watch` из teleproto: новые посты,
  правки и удаления приходят сразу. В публичные каналы вступать не нужно.
- **Страховка.** Раз в `POLL_INTERVAL_SECONDS` дочитывается всё новее
  последнего сохранённого поста, а у последних 30 обновляются просмотры,
  реакции и правки.
- **Индексация** отделена от чтения: сбой сервиса эмбеддингов не мешает
  забирать посты, очередь дочитывается сама. Переиндексируется только то, что
  изменилось по содержимому; смена модели или размера вектора
  переиндексирует всё автоматически.
- **Медиа → текст.** Фото, голосовые и кружки (по желанию — аудио, видео,
  GIF) скачиваются, ffmpeg готовит их (звук → mp3, из видео — кадры), и
  мультимодальная модель (по умолчанию Gemini через OpenRouter) делает
  дословную расшифровку речи, описание изображения и распознаёт текст на
  картинке. Результат хранится рядом с постом, ищется наравне с текстом и
  отдаётся нейросети в `media.transcript`, `media.description`,
  `media.text_on_image`.
- **Поиск гибридный:** по смыслу (pgvector, косинус) и по словам (полнотекстовый
  поиск Postgres с русской морфологией), выдачи сливаются через Reciprocal Rank
  Fusion. Без ключа эмбеддингов поиск работает по словам.

## Что видит нейросеть

| Инструмент | Что делает |
|---|---|
| `list_channels` | Пул: каналы, описание, сколько постов сохранено/проиндексировано, период |
| `search_posts` | Поиск по смыслу и словам, фильтры по каналам и датам, `mode`: hybrid / semantic / keyword |
| `list_posts` | Лента по времени: за период, по каналам, от новых или от старых, с перелистыванием |
| `get_post` | Пост целиком по ссылке `t.me/…`: все части альбома, пост, на который он отвечает, соседние посты |

Пост отдаётся полностью: текст с разметкой (ссылки, спрятанные в словах,
сохраняются), медиа (тип, файл, длительность, превью ссылки, опрос), альбом,
просмотры, пересылки, число комментариев, реакции, источник пересылки, автор,
ссылка на пост.

## Подключение нейросети

Одни и те же инструменты доступны тремя способами — выбирайте тот, который
понимает ваша модель или клиент.

**1. MCP** — Claude (Desktop, Code, claude.ai), ChatGPT, Cursor, Windsurf,
LM Studio, Cline, Continue, n8n и любые MCP-клиенты:

```json
{
  "mcpServers": {
    "telegram-rag": {
      "type": "http",
      "url": "https://<адрес>/mcp",
      "headers": { "Authorization": "Bearer <API_TOKEN>" }
    }
  }
}
```

Клиенту, который умеет только stdio: `npx mcp-remote https://<адрес>/mcp`.
Клиенту, который не умеет заголовки: `https://<адрес>/mcp?token=<API_TOKEN>`.

**2. Function calling** — любая модель, умеющая вызывать функции (OpenAI,
Gemini, Claude, Mistral, DeepSeek, Qwen, Llama через Ollama/vLLM, всё через
OpenRouter). Описания функций готовы в нужном формате:

```bash
curl https://<адрес>/api/tools                    # OpenAI / OpenRouter / Ollama / vLLM / Mistral / Groq
curl https://<адрес>/api/tools?format=anthropic   # Claude API
curl https://<адрес>/api/tools?format=gemini      # Gemini API
```

Модель просит вызвать функцию → ваш код отправляет её аргументы сюда:

```bash
curl -X POST https://<адрес>/api/tools/search_posts \
  -H 'Authorization: Bearer <API_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"query": "что писали про новые видеокарты", "limit": 5}'
```

**3. OpenAPI** — `https://<адрес>/openapi.json`: GPT Actions в ChatGPT, Dify,
Flowise, LangChain `OpenAPIToolkit` и любые агенты, которые читают OpenAPI.

Для людей и отладки: `GET /api/search?q=…&channels=@a,@b&from=2026-01-01&limit=5`.
Сводка всех адресов — `GET /`.

## Управление пулом

Каналы задаются в `TELEGRAM_CHANNELS` (добавляются при старте) или на лету,
с токеном владельца `ADMIN_TOKEN`:

```bash
# добавить (публичный — по имени/ссылке; закрытый — по приглашению, аккаунт вступит)
curl -X POST https://<адрес>/api/admin/channels -H 'Authorization: Bearer <ADMIN_TOKEN>' \
  -H 'Content-Type: application/json' -d '{"refs": ["@durov", "https://t.me/+AbCdEf"]}'

curl https://<адрес>/api/admin/channels -H 'Authorization: Bearer <ADMIN_TOKEN>'         # пул и очередь индексации
curl -X DELETE 'https://<адрес>/api/admin/channels/@durov' -H '…'                          # перестать следить (посты остаются)
curl -X DELETE 'https://<адрес>/api/admin/channels/@durov?purge=1' -H '…'                  # и удалить посты
curl -X POST https://<адрес>/api/admin/sync -H '…'                                         # опросить каналы сейчас
curl -X POST https://<адрес>/api/admin/retry-failed -H '…'                                 # переиндексировать упавшие
```

## Запуск

Нужны Node.js ≥ 24.12 (TypeScript исполняется напрямую, без сборки) и ffmpeg.

```bash
npm ci
cp .env.example .env         # заполнить TELEGRAM_API_ID/HASH и OPENROUTER_API_KEY
npm run login                # телефон → код → (пароль 2FA) → строка сессии
                             # вставить её в .env как TELEGRAM_SESSION
npm run dev                  # локально, база — PGlite в ./data, Docker не нужен
```

База — любой Postgres с pgvector по строке `DATABASE_URL`: в бою облачная
(Supabase или Neon), локально — встроенная PGlite в `./data` или контейнер
(`docker compose up --build` поднимает приложение и Postgres с pgvector).
Схему сервис создаёт сам.

Боевое развёртывание на VPS с облачной базой — как завести Supabase или Neon и чем они отличаются по лимитам (образ из GHCR, системный Caddy, автоматический
откат) — [deploy/README.md](./deploy/README.md).

### Аккаунт для userbot'а

Лучше отдельный аккаунт, а не личный: сессия даёт полный доступ к нему. Одна
сессия — один запущенный процесс: две копии с одной сессией выбивают друг
друга (как и у Mimic42). Для локальной разработки заводите вторую сессию
(`npm run login` ещё раз).

### Медиа

`MEDIA_TYPES` задаёт, что разбирать (по умолчанию `photo,voice,video_note`;
ещё есть `audio`, `video`, `gif`). Модель — `MEDIA_MODEL`, по умолчанию
`google/gemini-3.5-flash-lite`: одна модель слушает звук и смотрит картинки.
Подойдёт любая модель, принимающая изображения и `input_audio` через
OpenAI-совместимый API, — `MEDIA_BASE_URL` + `MEDIA_API_KEY`.

Разбор идёт отдельной очередью, сначала новые посты. `MEDIA_SINCE` ограничивает
историю датой: у каналов с тысячами фото разбор всего архива — заметный расход.
Слишком большие (`MEDIA_MAX_MB`) и длинные (`MEDIA_MAX_SECONDS`) файлы
пропускаются с причиной; ошибки повторяются через `POST /api/admin/retry-failed`.
Состояние очереди — в `GET /health` и `GET /api/admin/channels`. Нужен ffmpeg
(в Docker-образе есть; локально — `brew install ffmpeg`).

### Эмбеддинги

По умолчанию `google/gemini-embedding-001` через OpenRouter, вектор 1536
(модель умеет укорачивать вектор, HNSW в pgvector индексирует до 2000).
Любой OpenAI-совместимый сервис подключается переменными `EMBEDDING_*` —
например, локальная Ollama:

```bash
EMBEDDING_BASE_URL=http://ollama:11434/v1
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768
EMBEDDING_SEND_DIMENSIONS=false
```

Смена модели или размера пересоздаёт векторы автоматически при старте.

## Разработка

```bash
npm test             # логика + сервис целиком: PGlite с pgvector, HTTP, настоящий MCP-клиент
npm run typecheck
```

Проверки не ходят в сеть: база — PGlite в памяти, эмбеддинги и мультимодальная
модель — подмены, клиент Telegram — подмена с настоящими объектами teleproto,
ffmpeg — настоящий, на сгенерированных голосовом, кружке и фото.

## Структура

```
src/
  main.ts              вход: база → индексатор → userbot → HTTP
  config.ts            переменные окружения
  db.ts                Postgres (Supabase, Neon, свой) / PGlite, схема, переиндексация при смене модели
  store.ts             каналы, посты, куски, поиск по смыслу и словам
  embeddings.ts        любой OpenAI-совместимый сервис эмбеддингов
  chunks.ts            нарезка поста на куски с шапкой «канал, дата»
  indexer.ts           фоновая очередь эмбеддингов
  tools.ts             инструменты для нейросетей — одни на все способы подключения
  mcp.ts               MCP-сервер (Streamable HTTP, без сессий)
  http.ts              REST, OpenAPI, function calling, управление пулом
  media/
    ffmpeg.ts          звук → mp3, кадры из видео, уменьшение фото
    analyzer.ts        мультимодальная модель: расшифровка, описание, текст на картинке
    processor.ts       очередь разбора медиа
  telegram/
    client.ts          клиент teleproto, поиск канала по имени/приглашению/id
    ingest.ts          история, живые обновления, догоняющий опрос
    normalize.ts       сообщение MTProto → пост
  cli/login.ts         вход в аккаунт и строка сессии
tests/                 Vitest
deploy/                VPS: compose, выкатка с откатом, Caddy
```
