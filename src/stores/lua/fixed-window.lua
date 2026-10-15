-- Fixed-window rate limit: atomic check-and-increment with a server-side clock.
--
-- Mirror of `evaluateFixedWindow` in `src/algos/fixed-window.ts`, minus the
-- injectable clock: time comes from Redis `TIME` so concurrent Node instances
-- with skewed clocks still agree on window boundaries.
--
-- KEYS[1] = window key (HASH with fields `count`, `resetAtMs`)
-- ARGV[1] = limit (max points per window)
-- ARGV[2] = durationMs (window length in milliseconds)
-- ARGV[3] = pointsToConsume
--
-- Returns: { allowed (1/0), remaining, resetAtMs, retryAfterSec (-1 when allowed) }
-- The key always carries a TTL so idle buckets disappear (no key leak).

local key = KEYS[1]
local limit = tonumber(ARGV[1])
local durationMs = tonumber(ARGV[2])
local pointsToConsume = tonumber(ARGV[3])

-- Server-side clock: immune to client clock skew across instances.
local t = redis.call('TIME')
local nowMs = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)

local data = redis.call('HMGET', key, 'count', 'resetAtMs')
local count = tonumber(data[1])
local resetAtMs = tonumber(data[2])

local function persist(c, r)
  redis.call('HSET', key, 'count', c, 'resetAtMs', r)
  redis.call('PEXPIRE', key, math.max(math.floor(r - nowMs), 1))
end

-- Fresh window (missing key or expired).
if (count == nil or resetAtMs == nil or nowMs >= resetAtMs) then
  local reset = nowMs + durationMs
  if (pointsToConsume <= limit) then
    persist(pointsToConsume, reset)
    return {1, limit - pointsToConsume, reset, -1}
  else
    persist(pointsToConsume, reset)
    return {0, 0, reset, math.ceil((reset - nowMs) / 1000)}
  end
end

local nextCount = count + pointsToConsume
if (nextCount <= limit) then
  persist(nextCount, resetAtMs)
  return {1, limit - nextCount, resetAtMs, -1}
else
  -- Blocked: do NOT bump the counter or extend the window.
  return {0, 0, resetAtMs, math.ceil((resetAtMs - nowMs) / 1000)}
end
