import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Central config validation (TypeBox).
 *
 * Schemas are the single source of truth for every options object: invalid
 * configs throw a descriptive `Error` at construction time (fail fast) instead
 * of misbehaving at runtime. `RateLimitConfig` itself is derived from
 * `RateLimitConfigSchema` (see `types.ts`), so docs and validation
 * cannot drift apart.
 */

/** Point budgets: `points` and per-call `pointsToConsume`. Positive integers only. */
export const PointsSchema = Type.Integer({
  minimum: 1,
  description: "Point budget. Must be a positive integer.",
});

/** Window lengths in seconds. Fractions allowed (e.g. `0.5`); must be > 0. */
export const DurationSecSchema = Type.Number({
  exclusiveMinimum: 0,
  description: "Window length in seconds. Must be a finite number > 0.",
});

/** Bucket keys. Non-empty by contract (empty keys are almost always a bug). */
export const KeySchema = Type.String({
  minLength: 1,
  description: "Bucket key. Must be a non-empty string.",
});

/** Namespaces prepended to keys. Empty string is treated as absent. */
export const KeyPrefixSchema = Type.String({
  description: "Namespace prepended to keys. Empty string is treated as absent.",
});

/** Single source of truth for `RateLimitConfig`. */
export const RateLimitConfigSchema = Type.Object({
  points: PointsSchema,
  durationSec: DurationSecSchema,
  keyPrefix: Type.Optional(KeyPrefixSchema),
});

/** Mirrors `MemoryStoreOptions`. `clock` is checked as a function by the schema. */
export const MemoryStoreOptionsSchema = Type.Object({
  points: PointsSchema,
  durationSec: DurationSecSchema,
  cleanupIntervalMs: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Sweeper interval in ms. 0 disables the background sweeper.",
    }),
  ),
  // `() => number` (ms). TypeBox checks `typeof === "function"` at runtime.
  clock: Type.Optional(Type.Function([], Type.Number())),
});

/**
 * Mirrors `RedisStoreOptions`. `redis` must be an object (e.g. an ioredis
 * client) — its shape is checked manually since no JSON schema can express it.
 */
export const RedisStoreOptionsSchema = Type.Object({
  points: PointsSchema,
  durationSec: DurationSecSchema,
  redis: Type.Optional(Type.Unknown()),
  url: Type.Optional(Type.String({ minLength: 1 })),
  keyPrefix: Type.Optional(KeyPrefixSchema),
  failOpen: Type.Optional(Type.Boolean()),
  connectTimeoutMs: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  // `(err: unknown) => void`. TypeBox checks `typeof === "function"` at runtime.
  onError: Type.Optional(Type.Function([Type.Unknown()], Type.Void())),
});

/** Mirrors `CreateRateLimiterOptions` (`RateLimitConfig` + optional custom store). */
export const CreateRateLimiterOptionsSchema = Type.Composite([
  RateLimitConfigSchema,
  Type.Object({ store: Type.Optional(Type.Unknown()) }),
]);

function stringify(value: unknown): string {
  // NB: lib types say `string`, but it returns `undefined` for `undefined`/functions.
  const raw: unknown = JSON.stringify(value);
  return typeof raw === "string" ? raw : "undefined";
}

/**
 * Throw a single descriptive `Error` when `value` violates `schema`.
 * Narrows `value` to the schema's static type on success.
 *
 * Example message:
 * `createRateLimiter: invalid options: /points: Expected integer to be greater
 * or equal to 1 (got 0)`
 */
export function assertValidSchema<T extends TSchema>(
  schema: T,
  value: unknown,
  label: string,
): asserts value is Static<T> {
  if (Value.Check(schema, value)) {
    return;
  }
  const details = [...Value.Errors(schema, value)].map(
    (issue) => `${issue.path === "" ? "(value)" : issue.path}: ${issue.message}`,
  );
  throw new Error(`${label}: ${details.join("; ")} (got ${stringify(value)})`);
}

/** Guard for `Unknown`-typed fields that must be non-null objects (e.g. clients). */
export function assertObjectField(
  value: unknown,
  field: string,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label}: "${field}" must be an object (got ${stringify(value)})`);
  }
}
