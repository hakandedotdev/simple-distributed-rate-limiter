import { defineConfig } from "tsup";

// Bundles `src/index.ts` (resolving the `@/` alias) into runnable `dist/`
// output. Plain `tsc` cannot emit working JS for path aliases — it leaves them
// as-is — so the bundle step is what makes `@/` imports work outside tsx/vitest.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
});
