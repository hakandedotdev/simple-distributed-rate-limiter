import type { Static } from "@sinclair/typebox";
import type { RateLimitConfigSchema } from "@/schemas";

/**
 * Core types for the rate limiter.
 *
 * Validation lives in `schema.ts` (TypeBox).
 */

/**
 * Configuration for a rate limiter instance.
 * Derived from `RateLimitConfigSchema`, so the type and the validator
 * cannot drift apart. Field docs live on the schema as `description`s.
 */
export type RateLimitConfig = Static<typeof RateLimitConfigSchema>;

/** Result of a single `consume()` call. */
export interface RateLimitResult {
  /** Whether the request is allowed through. */
  allowed: boolean;
  /** Points remaining in the current window (0 when blocked). */
  remaining: number;
  /** Unix timestamp in ms when the current window resets. */
  resetAtMs: number;
  /** Seconds until retry, present only when `allowed === false`. */
  retryAfterSec?: number;
}

/**
 * Storage contract. Both `MemoryStore` (Phase 1) and `RedisStore` (Phase 2)
 * implement this, so limiters stay store-agnostic.
 */
export interface RateLimitStore {
  /**
   * Attempt to consume `pointsToConsume` (default 1) for `key`.
   * Must be safe to call concurrently for the same key
   * (atomic via Lua in Redis; single-threaded Map in memory).
   */
  consume(key: string, pointsToConsume?: number): Promise<RateLimitResult>;
  /** Remove the bucket/window for `key`, if present. */
  reset(key: string): Promise<void>;
  /** Remove all buckets/windows. */
  resetAll(): Promise<void>;
  /** Release timers/connections held by the store. */
  dispose(): Promise<void>;
}

/** Options accepted by {@link createRateLimiter}. */
export interface CreateRateLimiterOptions extends RateLimitConfig {
  /**
   * Custom store. Defaults to an in-memory fixed-window store.
   * Pass a Redis store in Phase 2 for distributed limiting.
   */
  store?: RateLimitStore;
}

/** Public rate limiter handle returned by {@link createRateLimiter}. */
export interface RateLimiter {
  readonly points: number;
  readonly durationSec: number;
  readonly keyPrefix: string | undefined;
  consume(key: string, pointsToConsume?: number): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
  resetAll(): Promise<void>;
  dispose(): Promise<void>;
}
