import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["apps/api/src/index.ts"],
      reporter: ["text-summary", "lcov"],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 80 },
    },
  },
});
