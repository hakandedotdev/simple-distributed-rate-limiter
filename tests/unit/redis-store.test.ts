import { describe, expect, it } from "vitest";
import { RedisStore } from "@/stores/redis-store";

// Nothing listening here: forces the Redis-failure path without needing Docker.
const UNREACHABLE_URL = "redis://127.0.0.1:6399";

describe("RedisStore failure handling (no Redis needed)", () => {
  it("rejects invalid config before connecting", () => {
    expect(() => new RedisStore({ points: 0, durationSec: 60 })).toThrow();
    expect(() => new RedisStore({ points: 1, durationSec: 0 })).toThrow();
  });

  it("fails open by default: allows traffic and reports via onError", async () => {
    const seen: unknown[] = [];
    const store = new RedisStore({
      points: 5,
      durationSec: 60,
      url: UNREACHABLE_URL,
      keyPrefix: `unit-failopen:${process.pid}`,
      onError: (err) => {
        seen.push(err);
      },
    });
    try {
      const res = await store.consume("user:1");
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(4);
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      await store.dispose();
    }
  });

  it("fails closed when failOpen is false", async () => {
    const store = new RedisStore({
      points: 5,
      durationSec: 60,
      url: UNREACHABLE_URL,
      keyPrefix: `unit-failclosed:${process.pid}`,
      failOpen: false,
    });
    try {
      await expect(store.consume("user:1")).rejects.toThrow();
    } finally {
      await store.dispose();
    }
  });

  it("validates consume args without touching Redis", async () => {
    const store = new RedisStore({
      points: 5,
      durationSec: 60,
      url: UNREACHABLE_URL,
      keyPrefix: `unit-validation:${process.pid}`,
    });
    try {
      await expect(store.consume("")).rejects.toThrow();
      await expect(store.consume("k", 0)).rejects.toThrow();
    } finally {
      await store.dispose();
    }
  });
});
