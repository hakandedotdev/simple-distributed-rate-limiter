import type {
  CreateRateLimiterOptions,
  RateLimiter,
  RateLimitResult,
  RateLimitStore,
} from "@/types";
import {
  assertObjectField,
  assertValidSchema,
  CreateRateLimiterOptionsSchema,
  KeySchema,
} from "@/schemas";
import { MemoryStore } from "@/stores/memory-store";

function namespacedKey(keyPrefix: string | undefined, key: string): string {
  assertValidSchema(KeySchema, key, "RateLimiter: invalid key");
  return keyPrefix === undefined || keyPrefix === "" ? key : `${keyPrefix}:${key}`;
}

/**
 * Create a rate limiter.
 *
 * ```ts
 * const limiter = createRateLimiter({ points: 5, durationSec: 60 });
 * const res = await limiter.consume("user:123");
 * if (!res.allowed) throw new Error(`Retry in ${res.retryAfterSec}s`);
 * ```
 *
 * Uses an in-memory fixed-window store by default. Pass `store` (e.g. Redis
 * in Phase 2) to share limits across processes.
 */
export function createRateLimiter(options: CreateRateLimiterOptions): RateLimiter {
  assertValidSchema(CreateRateLimiterOptionsSchema, options, "createRateLimiter: invalid options");
  if (options.store !== undefined) {
    assertObjectField(options.store, "store", "createRateLimiter: invalid options");
  }

  // `store` is `unknown` after schema narrowing (no JSON schema can express
  // the interface); the declared parameter type already guarantees its shape
  // for TypeScript callers, and the object check above guards JS callers.
  const store: RateLimitStore =
    (options.store as RateLimitStore | undefined) ??
    new MemoryStore({ points: options.points, durationSec: options.durationSec });

  return {
    points: options.points,
    durationSec: options.durationSec,
    keyPrefix: options.keyPrefix,

    async consume(key: string, pointsToConsume = 1): Promise<RateLimitResult> {
      return store.consume(namespacedKey(options.keyPrefix, key), pointsToConsume);
    },

    async reset(key: string): Promise<void> {
      await store.reset(namespacedKey(options.keyPrefix, key));
    },

    async resetAll(): Promise<void> {
      await store.resetAll();
    },

    async dispose(): Promise<void> {
      await store.dispose();
    },
  };
}

export type { CreateRateLimiterOptions, RateLimiter, RateLimitResult, RateLimitStore };
export {
  CreateRateLimiterOptionsSchema,
  KeyPrefixSchema,
  KeySchema,
  MemoryStoreOptionsSchema,
  PointsSchema,
  RateLimitConfigSchema,
  RedisStoreOptionsSchema,
  assertValidSchema,
} from "@/schemas";
export { MemoryStore } from "@/stores/memory-store";
export type { MemoryStoreOptions } from "@/stores/memory-store";
export { RedisStore } from "@/stores/redis-store";
export type { RedisStoreOptions } from "@/stores/redis-store";
export { evaluateFixedWindow } from "@/algos/fixed-window";
