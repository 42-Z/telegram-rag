# syntax=docker/dockerfile:1
# telegram-rag: userbot (teleproto) + индексатор + HTTP/MCP в одном процессе.
#
# Один процесс, одна копия: сессия Telegram живёт в памяти, две копии с одной
# сессией выбивают друг друга. Сборки нет — Node 24 исполняет TypeScript сам
# (срезает типы), поэтому в образ идут исходники как есть.

FROM node:24-slim

ENV NODE_ENV=production

# ffmpeg: звук голосовых и кружков → mp3, кадры из видео — для разбора медиа.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

COPY src ./src

USER node

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8000/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "src/main.ts"]
