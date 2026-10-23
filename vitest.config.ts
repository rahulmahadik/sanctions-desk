import { defineConfig } from "vitest/config";

export default defineConfig({
  // Next.js keeps JSX untouched in its own tsconfig; tests compile it themselves.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.{ts,tsx}"],
    // Component tests start with `// @vitest-environment jsdom`.
    environment: "node",
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts", "apps/web/lib/**/*.ts"],
      exclude: ["apps/api/src/index.ts"],
      reporter: ["text-summary", "lcov"],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 80 },
    },
  },
});
