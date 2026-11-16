import { describe, expect, it } from "vitest";
import { MediaGate } from "../src/media/gate.ts";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("MediaGate", () => {
  it("runs several ordinary jobs concurrently and returns their results", async () => {
    const gate = new MediaGate();
    const release = signal();
    const started = [signal(), signal(), signal()];
    const jobs = started.map((entry, index) => gate.use(async () => {
      entry.resolve();
      await release.promise;
      return index;
    }));
    await Promise.all(started.map((entry) => entry.promise));
    release.resolve();
    expect(await Promise.all(jobs)).toEqual([0, 1, 2]);
  });

  it("waits for all ordinary jobs and holds new jobs until the exclusive job finishes", async () => {
    const gate = new MediaGate();
    const firstStarted = signal();
    const secondStarted = signal();
    const releaseFirst = signal();
    const releaseSecond = signal();
    const exclusiveStarted = signal();
    const releaseExclusive = signal();
    const events: string[] = [];
    const first = gate.use(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push("first done");
    });
    const second = gate.use(async () => {
      secondStarted.resolve();
      await releaseSecond.promise;
      events.push("second done");
    });
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    const exclusive = gate.exclusive(async () => {
      events.push("exclusive start");
      exclusiveStarted.resolve();
      await releaseExclusive.promise;
      events.push("exclusive done");
      return "result";
    });
    const late = gate.use(async () => { events.push("late"); });
    releaseFirst.resolve();
    await first;
    expect(events).toEqual(["first done"]);
    releaseSecond.resolve();
    await exclusiveStarted.promise;
    expect(events).toEqual(["first done", "second done", "exclusive start"]);
    releaseExclusive.resolve();
    expect(await exclusive).toBe("result");
    await Promise.all([second, late]);
    expect(events).toEqual(["first done", "second done", "exclusive start", "exclusive done", "late"]);
  });

  it("serializes consecutive exclusive jobs before allowing new ordinary work", async () => {
    const gate = new MediaGate();
    const started = signal();
    const release = signal();
    const events: string[] = [];
    const first = gate.exclusive(async () => {
      events.push("first start");
      started.resolve();
      await release.promise;
      events.push("first done");
    });
    await started.promise;
    const second = gate.exclusive(async () => { events.push("second"); });
    const late = gate.use(async () => { events.push("late"); });
    expect(events).toEqual(["first start"]);
    release.resolve();
    await Promise.all([first, second, late]);
    expect(events).toEqual(["first start", "first done", "second", "late"]);
  });

  it.each(["use", "exclusive"] as const)("releases the gate after %s throws", async (kind) => {
    const gate = new MediaGate();
    const started = signal();
    const release = signal();
    const failed = gate[kind](async () => {
      started.resolve();
      await release.promise;
      throw new Error("job failed");
    });
    const rejection = expect(failed).rejects.toThrow("job failed");
    await started.promise;
    const exclusive = gate.exclusive(async () => "next exclusive");
    const ordinary = gate.use(async () => "next ordinary");
    release.resolve();
    await rejection;
    expect(await exclusive).toBe("next exclusive");
    expect(await ordinary).toBe("next ordinary");
  });

  it("tryExclusive skips active work immediately without blocking new ordinary jobs", async () => {
    const gate = new MediaGate();
    const started = signal();
    const release = signal();
    let exclusiveRan = false;
    const active = gate.use(async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    try {
      expect(await gate.tryExclusive(async () => { exclusiveRan = true; })).toBeUndefined();
      expect(exclusiveRan).toBe(false);
      expect(await gate.use(async () => "parallel job")).toBe("parallel job");
    } finally {
      release.resolve();
      await active;
    }
    expect(await gate.tryExclusive(async () => "idle result")).toBe("idle result");
  });

  it("tryExclusive skips an already queued exclusive job", async () => {
    const gate = new MediaGate();
    const release = signal();
    const started = signal();
    const active = gate.use(async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    let skippedRan = false;
    const queued = gate.exclusive(async () => "queued result");
    try {
      expect(await gate.tryExclusive(async () => { skippedRan = true; })).toBeUndefined();
      expect(skippedRan).toBe(false);
    } finally {
      release.resolve();
      await active;
    }
    expect(await queued).toBe("queued result");
  });

  it("tryExclusive releases its reservation when its work fails", async () => {
    const gate = new MediaGate();
    await expect(gate.tryExclusive(async () => { throw new Error("cleanup failed"); }))
      .rejects.toThrow("cleanup failed");
    expect(await gate.tryExclusive(async () => "recovered")).toBe("recovered");
    expect(await gate.use(async () => "ordinary")).toBe("ordinary");
  });
});
