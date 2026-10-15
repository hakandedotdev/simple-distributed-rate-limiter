import type {
  CreateRateLimiterOptions,
  RateLimiter,
  RateLimitResult,
  RateLimitStore,
} from "./core/types.js";
import { MemoryStore } from "./stores/memory-store.js";

function assertValidConfig(points: number, durationSec: number): void {
  if (!Number.isInteger(points) || points <= 0) {
    throw new Error(`createRateLimiter: "points" must be a positive integer, got ${points}`);
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(
      `createRateLimiter: "durationSec" must be a positive number, got ${durationSec}`,
    );
  }
}

function namespacedKey(keyPrefix: string | undefined, key: string): string {
  if (key.length === 0) {
    throw new Error("RateLimiter.consume: key must be a non-empty string");
  }
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
  assertValidConfig(options.points, options.durationSec);

  const store: RateLimitStore =
    options.store ?? new MemoryStore({ points: options.points, durationSec: options.durationSec });

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
export { MemoryStore } from "./stores/memory-store.js";
export { evaluateFixedWindow } from "./core/fixed-window.js";
