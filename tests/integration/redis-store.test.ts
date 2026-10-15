import { afterAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { createRateLimiter } from "@/index";
import { RedisStore } from "@/stores/redis-store";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
// Unique per run so parallel/local runs never share buckets.
const RUN = `${process.pid}:${Date.now()}`;
const PREFIX = `itest:${RUN}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isRedisReachable(url: string): Promise<boolean> {
  // NOTE: offline queue stays enabled here so the probe waits for the
  // connection instead of failing on the initial `connecting` race.
  // Bounded by connectTimeout + no reconnects.
  const probe = new Redis(url, {
    connectTimeout: 1000,
    retryStrategy: () => null,
  });
  probe.on("error", () => {});
  try {
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const redisAvailable = await isRedisReachable(REDIS_URL);
if (!redisAvailable) {
  console.warn(
    `[integration] Redis not reachable at ${REDIS_URL} — skipping. ` +
      `Start it with: pnpm start:redis (or set REDIS_URL).`,
  );
}

describe.skipIf(!redisAvailable)("RedisStore (integration)", () => {
  afterAll(async () => {
    const janitor = new RedisStore({
      points: 1,
      durationSec: 60,
      url: REDIS_URL,
      keyPrefix: PREFIX,
    });
    try {
      await janitor.resetAll();
    } finally {
      await janitor.dispose();
    }
  });

  it("allows up to the limit, then blocks with retryAfterSec (parity with MemoryStore)", async () => {
    const store = new RedisStore({ points: 3, durationSec: 60, url: REDIS_URL, keyPrefix: PREFIX });
    try {
      const key = `basic:${RUN}`;
      expect(await store.consume(key)).toMatchObject({ allowed: true, remaining: 2 });
      expect(await store.consume(key)).toMatchObject({ allowed: true, remaining: 1 });
      expect(await store.consume(key)).toMatchObject({ allowed: true, remaining: 0 });

      const blocked = await store.consume(key);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfterSec).toBeGreaterThan(0);
      expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
    } finally {
      await store.dispose();
    }
  });

  it("enforces ONE global limit across two concurrent clients (distributed proof)", async () => {
    const points = 10;
    const storeA = new RedisStore({ points, durationSec: 60, url: REDIS_URL, keyPrefix: PREFIX });
    const storeB = new RedisStore({ points, durationSec: 60, url: REDIS_URL, keyPrefix: PREFIX });
    try {
      const key = `shared:${RUN}`;
      // Simulate two Node processes racing for the same bucket.
      const attempts = await Promise.all([
        ...Array.from({ length: 10 }, () => storeA.consume(key)),
        ...Array.from({ length: 10 }, () => storeB.consume(key)),
      ]);
      const allowed = attempts.filter((r) => r.allowed);
      expect(allowed.length).toBe(points);

      // The limit is now exhausted globally: both clients see blocked.
      expect((await storeA.consume(key)).allowed).toBe(false);
      expect((await storeB.consume(key)).allowed).toBe(false);
    } finally {
      await storeA.dispose();
      await storeB.dispose();
    }
  });

  it("resets the window after expiry", async () => {
    const store = new RedisStore({ points: 2, durationSec: 1, url: REDIS_URL, keyPrefix: PREFIX });
    try {
      const key = `expiry:${RUN}`;
      expect((await store.consume(key)).allowed).toBe(true);
      expect((await store.consume(key)).allowed).toBe(true);
      expect((await store.consume(key)).allowed).toBe(false);

      await sleep(1100);
      const after = await store.consume(key);
      expect(after.allowed).toBe(true);
      expect(after.remaining).toBe(1);
    } finally {
      await store.dispose();
    }
  });

  it("isolates different keys and reports server-side resetAtMs", async () => {
    const store = new RedisStore({ points: 1, durationSec: 60, url: REDIS_URL, keyPrefix: PREFIX });
    try {
      const before = Date.now();
      const res = await store.consume(`iso-a:${RUN}`);
      expect(res.allowed).toBe(true);
      // resetAtMs comes from Redis TIME: ~now + window, not client skew.
      expect(res.resetAtMs).toBeGreaterThanOrEqual(before + 60_000 - 2000);
      expect(res.resetAtMs).toBeLessThanOrEqual(Date.now() + 60_000 + 2000);

      expect((await store.consume(`iso-b:${RUN}`)).allowed).toBe(true);
      expect((await store.consume(`iso-a:${RUN}`)).allowed).toBe(false);
    } finally {
      await store.dispose();
    }
  });

  it("reset() and resetAll() clear limits without FLUSHDB", async () => {
    const store = new RedisStore({ points: 1, durationSec: 60, url: REDIS_URL, keyPrefix: PREFIX });
    try {
      const keyA = `reset-a:${RUN}`;
      const keyB = `reset-b:${RUN}`;
      await store.consume(keyA);
      await store.consume(keyB);
      expect((await store.consume(keyA)).allowed).toBe(false);

      await store.reset(keyA);
      expect((await store.consume(keyA)).allowed).toBe(true);
      expect((await store.consume(keyB)).allowed).toBe(false);

      await store.resetAll();
      expect((await store.consume(keyB)).allowed).toBe(true);
    } finally {
      await store.dispose();
    }
  });

  it("works end-to-end through createRateLimiter with keyPrefix namespacing", async () => {
    const store = new RedisStore({ points: 1, durationSec: 60, url: REDIS_URL, keyPrefix: PREFIX });
    const limiter = createRateLimiter({ points: 1, durationSec: 60, keyPrefix: "api", store });
    try {
      expect((await limiter.consume("user:7")).allowed).toBe(true);
      expect((await limiter.consume("user:7")).allowed).toBe(false);
    } finally {
      await limiter.dispose();
    }
  });
});
