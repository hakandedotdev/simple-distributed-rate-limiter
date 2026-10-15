# Simple Distributed Rate Limiter (TypeScript)

> Phase 2 done: distributed fixed-window limiting via Redis + Lua.
> `MemoryStore` (single process) and `RedisStore` (multi instance) share one interface.

```ts
import { createRateLimiter, RedisStore } from "./src/index";

// Single process (dev / tests):
const local = createRateLimiter({ points: 5, durationSec: 60 });

// Distributed (all Node instances share one global limit):
const distributed = createRateLimiter({
  points: 5,
  durationSec: 60,
  keyPrefix: "api",
  store: new RedisStore({ points: 5, durationSec: 60 }),
});
const res = await distributed.consume("user:123");
if (!res.allowed) console.log(`Retry in ${res.retryAfterSec}s`);
```

## Run

```bash
pnpm install
pnpm test              # unit tests always run; integration skips without Redis
pnpm start:redis       # docker compose up -d redis
pnpm test              # now includes tests/integration (needs Redis on :6379 or REDIS_URL)
pnpm dev               # runs examples/basic.ts
```

## Architecture

```mermaid
Client -> API-1 -> Redis (Lua)
Client -> API-2 -> Redis (Lua)
```

## Why Lua? (distributed correctness)

A naive `GET` + `INCR` is two round trips: two Node instances can both read
`count = 9 / limit = 10` and both increment — 11 requests pass a 10-limit.
The Lua script in [`src/stores/lua/fixed-window.lua`](./src/stores/lua/fixed-window.lua)
runs the whole read-check-write **atomically on the Redis server**, so the
global limit holds no matter how many instances race. Covered by the
"ONE global limit across two concurrent clients" integration test.

Two more details that matter in production:

- **Server-side clock:** the script uses Redis `TIME`, not `Date.now()`,
  so app servers with skewed clocks still agree on window boundaries.
- **Failure mode is explicit:** `new RedisStore({ failOpen: true })` (default)
  lets traffic through with a best-effort result and reports via `onError`
  when Redis is down; `failOpen: false` throws so callers can 500 loudly.
- **No key leaks:** every window key gets a `PEXPIRE` equal to the window length.

Keys look like `ratelimit:<limiter-prefix>:<key>`
(`<keyPrefix>` on the store defaults to `"ratelimit"`; `createRateLimiter`
prepends its own `keyPrefix` first).

## Validation

Every options object is validated with [TypeBox](https://github.com/sinclairzx81/typebox)
schemas (`src/config.ts`, exported from the package). `RateLimitConfig`
is _derived_ from its schema, so the type and the validator cannot drift apart.
Bad configs throw a fail-fast error naming every offending field:

```text
createRateLimiter: invalid options: /points: Expected integer to be greater or equal to 1 (got {"points":0,...})
```

See [plan.md](./plan.md) for the full phase-by-phase roadmap.
