/**
 * Индексация: фоновый цикл берёт посты, у которых содержимое изменилось с
 * последнего построения векторов (новые, отредактированные, после смены
 * модели), режет их на куски и считает эмбеддинги пачками.
 *
 * Отделена от чтения Telegram: сбой или лимит сервиса эмбеддингов не мешает
 * забирать посты, а после восстановления очередь дочитывается сама.
 */

import { buildChunks } from "./chunks.ts";
import type { Embedder } from "./embeddings.ts";
import { logger } from "./log.ts";
import type { Store } from "./store.ts";
import { searchableText } from "./telegram/normalize.ts";

const log = logger("indexer");

export class Indexer {
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private wake: (() => void) | undefined;
  private stopped = false;

  private readonly store: Store;
  private readonly embedder: Embedder;
  private readonly batchSize: number;

  constructor(store: Store, embedder: Embedder, batchSize: number) {
    this.store = store;
    this.embedder = embedder;
    this.batchSize = batchSize;
  }

  /** Один проход по очереди. Возвращает, сколько постов обработано. */
  async runOnce(): Promise<number> {
    const posts = await this.store.pendingForEmbedding(this.batchSize);
    if (posts.length === 0) return 0;

    const jobs = posts.map((post) => ({
      post,
      chunks: buildChunks({ channelTitle: post.channelTitle, date: new Date(post.date), text: searchableText(post) }),
    }));
    const texts = jobs.flatMap((job) => job.chunks);

    let vectors: number[][] = [];
    try {
      // Пачка — не больше batchSize кусков за запрос.
      for (let i = 0; i < texts.length; i += this.batchSize) {
        vectors.push(...(await this.embedder.embed(texts.slice(i, i + this.batchSize))));
      }
    } catch (error) {
      if (jobs.length === 1) {
        await this.store.markEmbedError(jobs[0]!.post.channelId, jobs[0]!.post.messageId, String(error));
        log.warn(`пост ${jobs[0]!.post.channelId}/${jobs[0]!.post.messageId} не проиндексирован`, error);
        return 1;
      }
      // Пачка упала целиком — по одному, чтобы найти виноватый пост, а не
      // останавливать очередь из-за одного.
      log.warn(`пачка из ${jobs.length} постов не проиндексирована, повтор по одному`, error);
      vectors = [];
      let done = 0;
      for (const job of jobs) {
        try {
          const own = await this.embedder.embed(job.chunks);
          await this.store.replaceChunks(job.post, job.chunks.map((content, i) => ({ content, embedding: own[i]! })));
        } catch (single) {
          await this.store.markEmbedError(job.post.channelId, job.post.messageId, String(single));
          log.warn(`пост ${job.post.channelId}/${job.post.messageId} не проиндексирован`, single);
        }
        done += 1;
      }
      return done;
    }

    let offset = 0;
    for (const job of jobs) {
      const own = vectors.slice(offset, offset + job.chunks.length);
      offset += job.chunks.length;
      await this.store.replaceChunks(
        job.post,
        job.chunks.map((content, i) => ({ content, embedding: own[i]! })),
      );
    }
    log.debug(`проиндексировано постов: ${jobs.length}, кусков: ${texts.length}`);
    return jobs.length;
  }

  /** Постоянный цикл: пока есть очередь — без пауз, иначе ждёт сигнала или таймера. */
  start(idleMs = 60_000): void {
    const loop = async () => {
      if (this.stopped) return;
      this.running = true;
      let processed = 0;
      try {
        processed = await this.runOnce();
      } catch (error) {
        log.error("индексация упала, повтор позже", error);
        processed = 0;
      }
      this.running = false;
      if (this.stopped) return;
      if (processed > 0) {
        setImmediate(loop);
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, idleMs);
      });
      clearTimeout(this.timer);
      this.wake = undefined;
      void loop();
    };
    void loop();
  }

  /** Новые посты пришли — не ждать таймера. */
  notify(): void {
    if (!this.running) this.wake?.();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }
}
