import { describe, expect, it } from "vitest";
import { evaluateFixedWindow } from "../../src/core/fixed-window.js";

describe("evaluateFixedWindow (pure logic)", () => {
  const limit = 3;
  const durationMs = 60_000;

  it("starts a new window when no state exists", () => {
    const { result, nextState } = evaluateFixedWindow({
      state: undefined,
      nowMs: 1_000,
      pointsToConsume: 1,
      limit,
      durationMs,
    });

    expect(result).toEqual({ allowed: true, remaining: 2, resetAtMs: 61_000 });
    expect(nextState).toEqual({ count: 1, resetAtMs: 61_000 });
  });

  it("accumulates within an active window and blocks when exceeded", () => {
    const first = evaluateFixedWindow({
      state: undefined,
      nowMs: 0,
      pointsToConsume: 2,
      limit,
      durationMs,
    });
    expect(first.result.allowed).toBe(true);
    expect(first.result.remaining).toBe(1);

    const second = evaluateFixedWindow({
      state: first.nextState,
      nowMs: 1_000,
      pointsToConsume: 1,
      limit,
      durationMs,
    });
    expect(second.result).toMatchObject({ allowed: true, remaining: 0 });

    const blocked = evaluateFixedWindow({
      state: second.nextState,
      nowMs: 2_000,
      pointsToConsume: 1,
      limit,
      durationMs,
    });
    expect(blocked.result.allowed).toBe(false);
    expect(blocked.result.remaining).toBe(0);
    expect(blocked.result.retryAfterSec).toBe(58);
    // Blocked requests must not extend the window or inflate the counter.
    expect(blocked.nextState).toEqual(second.nextState);
  });

  it("resets when the window expires (boundary is exclusive)", () => {
    const active = { count: 3, resetAtMs: 60_000 };
    const { result } = evaluateFixedWindow({
      state: active,
      nowMs: 60_000,
      pointsToConsume: 1,
      limit,
      durationMs,
    });
    expect(result).toEqual({ allowed: true, remaining: 2, resetAtMs: 120_000 });
  });

  it("rejects a single consume larger than the limit but keeps a stable window", () => {
    const { result, nextState } = evaluateFixedWindow({
      state: undefined,
      nowMs: 0,
      pointsToConsume: 10,
      limit,
      durationMs,
    });
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSec).toBe(60);
    expect(nextState.resetAtMs).toBe(60_000);
  });
});
