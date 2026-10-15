import type { RateLimitResult } from "@/types";

/**
 * Pure fixed-window evaluation logic (no I/O, no Date calls).
 *
 * Extracted so it can be unit-tested deterministically and reused by
 * both the memory store and the Redis Lua script.
 */
export interface FixedWindowState {
  /** Points consumed so far in the current window. */
  count: number;
  /** Unix timestamp in ms when the current window ends. */
  resetAtMs: number;
}

export interface EvaluateFixedWindowInput {
  /** Previously stored state, or `undefined` if no window exists / it expired. */
  state: FixedWindowState | undefined;
  nowMs: number;
  pointsToConsume: number;
  limit: number;
  durationMs: number;
}

export interface EvaluateFixedWindowOutput {
  result: RateLimitResult;
  /** State to persist for the next call. */
  nextState: FixedWindowState;
}

export function evaluateFixedWindow(input: EvaluateFixedWindowInput): EvaluateFixedWindowOutput {
  const { state, nowMs, pointsToConsume, limit, durationMs } = input;

  // No window yet, or the old one expired -> start a fresh window.
  if (state === undefined || nowMs >= state.resetAtMs) {
    const resetAtMs = nowMs + durationMs;
    if (pointsToConsume <= limit) {
      return {
        result: { allowed: true, remaining: limit - pointsToConsume, resetAtMs },
        nextState: { count: pointsToConsume, resetAtMs },
      };
    }
    return {
      result: {
        allowed: false,
        remaining: 0,
        resetAtMs,
        retryAfterSec: Math.ceil((resetAtMs - nowMs) / 1000),
      },
      // Still record the attempt so `resetAtMs` stays stable for the window.
      nextState: { count: pointsToConsume, resetAtMs },
    };
  }

  // Inside an active window.
  const nextCount = state.count + pointsToConsume;
  if (nextCount <= limit) {
    return {
      result: {
        allowed: true,
        remaining: limit - nextCount,
        resetAtMs: state.resetAtMs,
      },
      nextState: { count: nextCount, resetAtMs: state.resetAtMs },
    };
  }

  return {
    result: {
      allowed: false,
      remaining: 0,
      resetAtMs: state.resetAtMs,
      retryAfterSec: Math.ceil((state.resetAtMs - nowMs) / 1000),
    },
    // Do NOT bump the counter on blocked requests: `remaining` stays 0 and
    // the window still resets on time instead of being extended by abuse.
    nextState: state,
  };
}
