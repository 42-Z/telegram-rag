/** Индексация и загрузки идут параллельно; удаление ждёт их и не пускает новые. */
export class MediaGate {
  private active = 0;
  private queue: Promise<void> = Promise.resolve();
  private drained: (() => void) | undefined;
  private exclusiveCount = 0;

  async use<T>(work: () => Promise<T>): Promise<T> {
    while (true) {
      const queue = this.queue;
      await queue;
      if (queue === this.queue) break;
    }
    this.active++;
    try {
      return await work();
    } finally {
      if (--this.active === 0) this.drained?.();
    }
  }

  exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.exclusiveCount++;
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    return (async () => {
      await previous;
      if (this.active > 0) await new Promise<void>((resolve) => { this.drained = resolve; });
      try {
        return await work();
      } finally {
        this.drained = undefined;
        this.exclusiveCount--;
        release();
      }
    })();
  }

  tryExclusive<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.active > 0 || this.exclusiveCount > 0) return Promise.resolve(undefined);
    return this.exclusive(work);
  }
}
