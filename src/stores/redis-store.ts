import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import type { Redis as RedisClient } from "ioredis";
import type { RateLimitResult, RateLimitStore } from "@/types";
import {
  assertObjectField,
  assertValidSchema,
  KeySchema,
  PointsSchema,
  RedisStoreOptionsSchema,
} from "@/schemas";

const CONSUME_COMMAND = "rlFixedWindowConsume";

function loadLuaScript(filename: string): string {
  // Resolves in both layouts:
  // - source/test run: <repo>/src/stores/lua/<file>  (tsx, vitest)
  // - built output:    <repo>/dist/src/stores/lua/<file> (copied by postbuild)
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "lua", filename), "utf8");
}

/** ioredis client extended with the Lua command registered in the constructor. */
type RedisWithConsume = RedisClient & {
  [CONSUME_COMMAND]: (
    key: string,
    limit: number,
    durationMs: number,
    points: number,
  ) => Promise<number[]>;
};

export interface RedisStoreOptions {
  points: number;
  durationSec: number;
  /**
   * Existing connection (e.g. shared across stores, or managed by the host app).
   * When provided, `dispose()` will NOT close it.
   */
  redis?: RedisClient;
  /** Used only when `redis` is not provided. Defaults to `REDIS_URL` or localhost. */
  url?: string;
  /** Namespace for all keys. Final key: `<keyPrefix>:<key>`. Defaults to `"ratelimit"`. */
  keyPrefix?: string;
  /**
   * When Redis is unreachable: `true` (default) allows the request through
   * with a best-effort result and reports via `onError`; `false` rethrows.
   */
  failOpen?: boolean;
  /**
   * Max ms to wait for a (re)connection before failing the operation
   * (then `failOpen` applies). Defaults to 2000.
   */
  connectTimeoutMs?: number;
  /** Called with the underlying error on every Redis failure. Defaults to `console.warn`. */
  onError?: (err: unknown) => void;
}

/**
 * Distributed fixed-window store backed by Redis.
 *
 * Correctness across N Node instances comes from a single Lua script:
 * read-check-write happens atomically on the Redis server, so two processes
 * racing to consume the last point cannot both succeed (unlike a naive
 * `GET` + `INCR` round-trip pair). The window clock is Redis `TIME`, not
 * `Date.now()`, so skewed app-server clocks cannot shift window boundaries.
 *
 * Token-bucket / sliding-window scripts arrive in Phase 3; the interface
 * stays identical so swapping strategies is a one-line change.
 */
export class RedisStore implements RateLimitStore {
  private readonly points: number;
  private readonly durationMs: number;
  private readonly redis: RedisWithConsume;
  private readonly ownsConnection: boolean;
  private readonly keyPrefix: string;
  private readonly failOpen: boolean;
  private readonly connectTimeoutMs: number;
  private readonly onError: (err: unknown) => void;
  /** Shared by concurrent callers so a connection race adds one listener pair, not N. */
  private readyWait: Promise<void> | undefined;

  constructor(options: RedisStoreOptions) {
    assertValidSchema(RedisStoreOptionsSchema, options, "RedisStore: invalid options");
    this.points = options.points;
    this.durationMs = options.durationSec * 1000;
    this.keyPrefix = options.keyPrefix ?? "ratelimit";
    this.failOpen = options.failOpen ?? true;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 2000;
    this.onError =
      options.onError ??
      ((err: unknown) => {
        console.warn("[rate-limiter] Redis error, failing open:", err);
      });

    if (options.redis !== undefined) {
      assertObjectField(options.redis, "redis", "RedisStore: invalid options");
      // No JSON schema can express the client interface; the declared
      // parameter type covers TS callers, the object check guards JS callers.
      this.redis = options.redis as unknown as RedisWithConsume;
      this.ownsConnection = false;
    } else {
      const client = new Redis(options.url ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
        // Fail fast so `failOpen` degrades instead of hanging the request.
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
      });
      // Prevent unhandled 'error' crashes on background reconnects.
      // Command failures still surface per-call and route to `onError`.
      client.on("error", () => {});
      this.redis = client as RedisWithConsume;
      this.ownsConnection = true;
    }

    this.redis.defineCommand(CONSUME_COMMAND, {
      lua: loadLuaScript("fixed-window.lua"),
      numberOfKeys: 1,
    });
  }

  async consume(key: string, pointsToConsume = 1): Promise<RateLimitResult> {
    assertValidSchema(KeySchema, key, "RedisStore.consume: invalid key");
    assertValidSchema(PointsSchema, pointsToConsume, "RedisStore.consume: invalid pointsToConsume");
    try {
      // Tolerates the initial-connect race (status `connecting` right after
      // construction) without letting commands hang when Redis is actually down:
      // 'close' rejects fast, and the timeout bounds the worst case.
      await this.waitForReady();
      const reply = await this.redis[CONSUME_COMMAND](
        this.namespaced(key),
        this.points,
        this.durationMs,
        pointsToConsume,
      );
      if (!Array.isArray(reply) || reply.length !== 4) {
        throw new Error(`RedisStore: unexpected Lua reply: ${JSON.stringify(reply)}`);
      }
      const [allowedRaw = 0, remaining = 0, resetAtMs = 0, retryAfterRaw = -1] = reply;
      const result: RateLimitResult = {
        allowed: allowedRaw === 1,
        remaining,
        resetAtMs,
      };
      if (retryAfterRaw >= 0) {
        result.retryAfterSec = retryAfterRaw;
      }
      return result;
    } catch (err) {
      return this.handleRedisError(err, pointsToConsume);
    }
  }

  async reset(key: string): Promise<void> {
    await this.waitForReady();
    await this.redis.del(this.namespaced(key));
  }

  /**
   * Deletes every key under this store's prefix via `SCAN` (single node).
   * Never uses `FLUSHDB` — safe to call on a shared Redis.
   */
  async resetAll(): Promise<void> {
    await this.waitForReady();
    const pattern = `${this.keyPrefix}:*`;
    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== "0");
  }

  async dispose(): Promise<void> {
    if (this.ownsConnection) {
      try {
        await this.redis.quit();
      } catch {
        this.redis.disconnect();
      }
    }
  }

  private namespaced(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }

  /**
   * Wait until the connection is usable. Resolves immediately when already
   * ready; rejects fast on `close` (Redis down) and bounds the worst case
   * with `connectTimeoutMs` so operations never hang indefinitely.
   */
  private waitForReady(): Promise<void> {
    if (this.redis.status === "ready") {
      return Promise.resolve();
    }
    if (this.readyWait === undefined) {
      const pending = this.watchForReady();
      this.readyWait = pending;
      const clear = (): void => {
        if (this.readyWait === pending) {
          this.readyWait = undefined;
        }
      };
      pending.then(clear, clear);
    }
    return this.readyWait;
  }

  private watchForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.redis.off("ready", onReady);
        this.redis.off("close", onClose);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("RedisStore: timed out waiting for Redis connection"));
      }, this.connectTimeoutMs);
      const onReady = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("RedisStore: Redis connection closed"));
      };
      this.redis.once("ready", onReady);
      this.redis.once("close", onClose);
    });
  }

  private handleRedisError(err: unknown, pointsToConsume: number): Promise<RateLimitResult> {
    if (!this.failOpen) {
      throw err;
    }
    this.onError(err);
    // Best-effort degraded result: let traffic through rather than 500 everything.
    return Promise.resolve({
      allowed: true,
      remaining: Math.max(0, this.points - pointsToConsume),
      resetAtMs: Date.now() + this.durationMs,
    });
  }
}
