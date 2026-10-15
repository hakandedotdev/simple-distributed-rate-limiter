import { createRateLimiter } from "../src/index.js";

const limiter = createRateLimiter({ points: 5, durationSec: 60 });

for (let i = 1; i <= 7; i++) {
  const res = await limiter.consume("demo-user");
  console.log(
    `request ${i}: ${res.allowed ? "ALLOWED" : "BLOCKED"} (remaining=${res.remaining}` +
      (res.retryAfterSec !== undefined ? `, retryAfter=${res.retryAfterSec}s` : "") +
      `)`,
  );
}

await limiter.dispose();
