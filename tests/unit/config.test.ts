import { describe, expect, it } from "vitest";
import {
  assertValidSchema,
  CreateRateLimiterOptionsSchema,
  createRateLimiter,
  KeySchema,
  MemoryStore,
  MemoryStoreOptionsSchema,
  PointsSchema,
  RateLimitConfigSchema,
  RedisStore,
  RedisStoreOptionsSchema,
} from "@/index";
import type { CreateRateLimiterOptions, MemoryStoreOptions, RedisStoreOptions } from "@/index";

/** Bypass static types to simulate JS callers / parsed JSON configs. */
function asLimiterOptions(value: object): CreateRateLimiterOptions {
  return value as CreateRateLimiterOptions;
}

/** Bypass static types to simulate JS callers / parsed JSON configs. */
function asMemoryOptions(value: object): MemoryStoreOptions {
  return value as MemoryStoreOptions;
}

/** Bypass static types to simulate JS callers / parsed JSON configs. */
function asRedisOptions(value: object): RedisStoreOptions {
  return value as RedisStoreOptions;
}

describe("config validation (TypeBox)", () => {
  it("exports the schemas and the assert helper", () => {
    for (const schema of [
      RateLimitConfigSchema,
      MemoryStoreOptionsSchema,
      RedisStoreOptionsSchema,
      CreateRateLimiterOptionsSchema,
      PointsSchema,
      KeySchema,
    ]) {
      expect(schema).toBeTypeOf("object");
    }
    expect(assertValidSchema).toBeTypeOf("function");
  });

  it("accepts valid configs, including edge cases", () => {
    const limiter = createRateLimiter({ points: 5, durationSec: 60 });
    expect(limiter.points).toBe(5);

    // Fractional windows, empty prefix (= absent), zero cleanup interval.
    const fractional = createRateLimiter({ points: 1, durationSec: 0.5, keyPrefix: "" });
    expect(fractional.durationSec).toBe(0.5);

    const custom = createRateLimiter({
      points: 2,
      durationSec: 60,
      store: new MemoryStore({ points: 2, durationSec: 60, cleanupIntervalMs: 0 }),
    });
    expect(custom.points).toBe(2);

    void limiter.dispose();
    void fractional.dispose();
    void custom.dispose();
  });

  it("createRateLimiter rejects bad points/duration with the field in the message", () => {
    for (const points of [0, -1, 1.5, Number.NaN, "5", null]) {
      expect(() => createRateLimiter(asLimiterOptions({ points, durationSec: 60 }))).toThrow(
        "/points",
      );
    }
    for (const durationSec of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "60", null]) {
      expect(() => createRateLimiter(asLimiterOptions({ points: 5, durationSec }))).toThrow(
        "/durationSec",
      );
    }
    expect(() =>
      createRateLimiter(asLimiterOptions({ points: 5, durationSec: 60, keyPrefix: 42 })),
    ).toThrow("/keyPrefix");
    expect(() =>
      createRateLimiter(asLimiterOptions({ points: 5, durationSec: 60, store: 42 })),
    ).toThrow('"store"');
  });

  it("MemoryStore rejects bad store options", () => {
    expect(() => new MemoryStore(asMemoryOptions({ durationSec: 60 }))).toThrow("/points");
    for (const cleanupIntervalMs of [-1, 1.5, "fast"]) {
      expect(
        () => new MemoryStore(asMemoryOptions({ points: 1, durationSec: 60, cleanupIntervalMs })),
      ).toThrow("/cleanupIntervalMs");
    }
    expect(
      () => new MemoryStore(asMemoryOptions({ points: 1, durationSec: 60, clock: 42 })),
    ).toThrow("/clock");
  });

  it("RedisStore rejects bad store options without connecting", () => {
    for (const url of ["", 42]) {
      expect(() => new RedisStore(asRedisOptions({ points: 1, durationSec: 60, url }))).toThrow(
        "/url",
      );
    }
    expect(
      () => new RedisStore(asRedisOptions({ points: 1, durationSec: 60, failOpen: "yes" })),
    ).toThrow("/failOpen");
    expect(
      () => new RedisStore(asRedisOptions({ points: 1, durationSec: 60, connectTimeoutMs: 0 })),
    ).toThrow("/connectTimeoutMs");
    expect(
      () => new RedisStore(asRedisOptions({ points: 1, durationSec: 60, onError: 1 })),
    ).toThrow("/onError");
    for (const redis of [null, 42, "client"]) {
      expect(() => new RedisStore(asRedisOptions({ points: 1, durationSec: 60, redis }))).toThrow(
        '"redis"',
      );
    }
  });

  it("consume() validates keys and point amounts (memory store)", async () => {
    const store = new MemoryStore({ points: 5, durationSec: 60, cleanupIntervalMs: 0 });
    try {
      await expect(store.consume("")).rejects.toThrow("invalid key");
      await expect(store.consume("k", 0)).rejects.toThrow("invalid pointsToConsume");
      await expect(store.consume("k", -2)).rejects.toThrow("invalid pointsToConsume");
      await expect(store.consume("k", 1.5)).rejects.toThrow("invalid pointsToConsume");
    } finally {
      await store.dispose();
    }
  });

  it("consume() validates keys through the limiter wrapper", async () => {
    const limiter = createRateLimiter({ points: 5, durationSec: 60 });
    try {
      await expect(limiter.consume("")).rejects.toThrow("invalid key");
    } finally {
      await limiter.dispose();
    }
  });

  it("assertValidSchema narrows on success and lists every violation", () => {
    const raw: unknown = { points: 5, durationSec: 60 };
    assertValidSchema(RateLimitConfigSchema, raw, "test");
    // Narrowed: statically usable as a config.
    expect(raw.points + raw.durationSec).toBe(65);

    let message = "";
    try {
      assertValidSchema(
        RateLimitConfigSchema,
        { points: 0, durationSec: -1 },
        "test: invalid config",
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("test: invalid config");
    expect(message).toContain("/points");
    expect(message).toContain("/durationSec");
  });
});
