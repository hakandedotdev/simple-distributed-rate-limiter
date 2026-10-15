import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/stores/memory-store.js";
import { createRateLimiter } from "../../src/index.js";

describe("MemoryStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to the limit, then blocks with retryAfterSec", async () => {
    const store = new MemoryStore({ points: 3, durationSec: 60, cleanupIntervalMs: 0 });
    try {
      expect((await store.consume("ip:1")).allowed).toBe(true);
      expect((await store.consume("ip:1")).remaining).toBe(1);
      expect((await store.consume("ip:1")).remaining).toBe(0);

      const blocked = await store.consume("ip:1");
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfterSec).toBeGreaterThan(0);
      expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
    } finally {
      await store.dispose();
    }
  });

  it("isolates different keys", async () => {
    const store = new MemoryStore({ points: 1, durationSec: 60, cleanupIntervalMs: 0 });
    try {
      expect((await store.consume("a")).allowed).toBe(true);
      expect((await store.consume("b")).allowed).toBe(true);
      expect((await store.consume("a")).allowed).toBe(false);
      expect((await store.consume("b")).allowed).toBe(false);
    } finally {
      await store.dispose();
    }
  });

  it("resets the window after the duration passes (fake timers)", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    // Note: MemoryStore defaults to Date.now, which follows mocked system time.
    const store = new MemoryStore({ points: 2, durationSec: 60, cleanupIntervalMs: 0 });
    try {
      expect((await store.consume("k")).allowed).toBe(true);
      expect((await store.consume("k")).allowed).toBe(true);
      expect((await store.consume("k")).allowed).toBe(false);

      vi.setSystemTime(now + 60_000);
      const after = await store.consume("k");
      expect(after.allowed).toBe(true);
      expect(after.remaining).toBe(1);
    } finally {
      await store.dispose();
    }
  });

  it("supports consuming multiple points at once", async () => {
    const store = new MemoryStore({ points: 5, durationSec: 60, cleanupIntervalMs: 0 });
    try {
      const res = await store.consume("bulk", 3);
      expect(res).toMatchObject({ allowed: true, remaining: 2 });
      const blocked = await store.consume("bulk", 3);
      expect(blocked.allowed).toBe(false);
    } finally {
      await store.dispose();
    }
  });

  it("reset() and resetAll() clear limits", async () => {
    const store = new MemoryStore({ points: 1, durationSec: 60, cleanupIntervalMs: 0 });
    try {
      await store.consume("a");
      await store.consume("b");
      expect((await store.consume("a")).allowed).toBe(false);

      await store.reset("a");
      expect((await store.consume("a")).allowed).toBe(true);

      await store.resetAll();
      expect((await store.consume("b")).allowed).toBe(true);
    } finally {
      await store.dispose();
    }
  });

  it("sweeps expired windows on a timer (no leak)", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);
    const store = new MemoryStore({ points: 1, durationSec: 60, cleanupIntervalMs: 1_000 });
    try {
      await store.consume("temp");
      expect(store.size).toBe(1);
      vi.setSystemTime(start + 61_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(store.size).toBe(0);
    } finally {
      // dispose() clears the interval so the worker can exit.
      await store.dispose();
    }
  });

  it("validates constructor args and consume args", async () => {
    expect(() => new MemoryStore({ points: 0, durationSec: 60 })).toThrow();
    expect(() => new MemoryStore({ points: 1, durationSec: 0 })).toThrow();

    const store = new MemoryStore({ points: 1, durationSec: 60, cleanupIntervalMs: 0 });
    try {
      await expect(store.consume("")).rejects.toThrow();
      await expect(store.consume("k", 0)).rejects.toThrow();
    } finally {
      await store.dispose();
    }
  });
});

describe("createRateLimiter", () => {
  it("exposes points/duration and applies keyPrefix namespacing", async () => {
    const limiter = createRateLimiter({ points: 1, durationSec: 60, keyPrefix: "test" });
    try {
      expect(limiter.points).toBe(1);
      expect(limiter.durationSec).toBe(60);

      expect((await limiter.consume("user:1")).allowed).toBe(true);
      expect((await limiter.consume("user:1")).allowed).toBe(false);

      // Same raw key under a different prefix is an independent bucket.
      const other = createRateLimiter({ points: 1, durationSec: 60, keyPrefix: "other" });
      try {
        expect((await other.consume("user:1")).allowed).toBe(true);
      } finally {
        await other.dispose();
      }
    } finally {
      await limiter.dispose();
    }
  });

  it("rejects invalid config", () => {
    expect(() => createRateLimiter({ points: 0, durationSec: 60 })).toThrow();
    expect(() => createRateLimiter({ points: 5, durationSec: -1 })).toThrow();
  });
});
