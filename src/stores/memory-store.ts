import { evaluateFixedWindow, type FixedWindowState } from "@/algos/fixed-window";
import { assertValidSchema, KeySchema, MemoryStoreOptionsSchema, PointsSchema } from "@/schemas";
import type { RateLimitResult, RateLimitStore } from "@/types";

export interface MemoryStoreOptions {
  points: number;
  durationSec: number;
  /**
   * How often (ms) to sweep expired windows. Defaults to `min(durationMs, 60s)`.
   * Set to `0` to disable the background sweeper (entries are still
   * lazily expired on `consume()`).
   */
  cleanupIntervalMs?: number;
  /** Clock override for deterministic tests. Defaults to `Date.now`. */
  clock?: () => number;
}

/**
 * In-memory fixed-window store.
 *
 * - Single-process only. For multi-instance limiting see `RedisStore` (Phase 2).
 * - Node is single-threaded so `consume()` is effectively atomic here.
 * - Expired windows are reset lazily on access + eagerly via a sweeper timer.
 * - Methods are `async` to match the `RateLimitStore` contract (the Redis
 *   implementation in Phase 2 does real I/O here).
 */
/* eslint-disable @typescript-eslint/require-await */
export class MemoryStore implements RateLimitStore {
  private readonly points: number;
  private readonly durationMs: number;
  private readonly clock: () => number;
  private readonly buckets = new Map<string, FixedWindowState>();
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(options: MemoryStoreOptions) {
    assertValidSchema(MemoryStoreOptionsSchema, options, "MemoryStore: invalid options");
    this.points = options.points;
    this.durationMs = options.durationSec * 1000;
    this.clock = options.clock ?? Date.now;

    const interval = options.cleanupIntervalMs ?? Math.min(this.durationMs, 60_000);
    if (interval > 0) {
      this.cleanupTimer = setInterval(() => {
        this.sweepExpired();
      }, interval);
      // Don't keep the process alive just for the sweeper.
      this.cleanupTimer.unref();
    }
  }

  async consume(key: string, pointsToConsume = 1): Promise<RateLimitResult> {
    assertValidSchema(KeySchema, key, "MemoryStore.consume: invalid key");
    assertValidSchema(
      PointsSchema,
      pointsToConsume,
      "MemoryStore.consume: invalid pointsToConsume",
    );
    const nowMs = this.clock();
    const { result, nextState } = evaluateFixedWindow({
      state: this.buckets.get(key),
      nowMs,
      pointsToConsume,
      limit: this.points,
      durationMs: this.durationMs,
    });
    this.buckets.set(key, nextState);
    return result;
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  async resetAll(): Promise<void> {
    this.buckets.clear();
  }

  async dispose(): Promise<void> {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.buckets.clear();
  }

  /** Visible for tests: number of tracked windows (including possibly expired). */
  get size(): number {
    return this.buckets.size;
  }

  private sweepExpired(): void {
    const nowMs = this.clock();
    for (const [key, state] of this.buckets) {
      if (nowMs >= state.resetAtMs) {
        this.buckets.delete(key);
      }
    }
  }
}
