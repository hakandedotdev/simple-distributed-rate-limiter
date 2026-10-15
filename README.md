# Simple Distributed Rate Limiter (TypeScript)

> Phase 1 done: in-memory fixed-window limiter. Phase 2 adds Redis for distributed limiting.

```ts
import { createRateLimiter } from "./src/index.js";

const limiter = createRateLimiter({ points: 5, durationSec: 60 });
const res = await limiter.consume("user:123");
if (!res.allowed) console.log(`Retry in ${res.retryAfterSec}s`);
```

## Run

```bash
pnpm install
pnpm test
pnpm dev   # runs examples/basic.ts
```

## Architecture (target)

```mermaid
Client -> API-1 -> Redis (Lua)
Client -> API-2 -> Redis (Lua)
```

Phase 1 uses `MemoryStore` (single process). Phase 2 swaps in `RedisStore`
implementing the same `RateLimitStore` interface.

See [plan.md](./plan.md) for the full phase-by-phase roadmap.
