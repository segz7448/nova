import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    teardownTimeout: 5_000,
    include: ["src/__tests__/**/*.test.ts"],
    exclude: [
      "node_modules/**",
      // These use node:test's describe/it, not vitest's — vitest's glob
      // picks them up anyway and fails to collect them (wrong test
      // framework, not a real bug). alibaba-client*.test.ts are real,
      // passing tests meant to run via `npm run test:node` (see
      // package.json). The runtime-reference/* files are explicitly
      // dead reference code from the agent-runtime merge (see their own
      // header comments and /MERGE-NOTES.md) — their imports point at
      // files that were deliberately not carried over, so they don't
      // even compile in this repo and were never meant to run anywhere.
      "src/__tests__/alibaba-client.test.ts",
      "src/__tests__/alibaba-client-disk.test.ts",
      "src/__tests__/runtime-reference/**",
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/__tests__/**",
        "src/types.ts",
        "node_modules/**",
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 55,
        lines: 60,
      },
      reporter: ["text", "text-summary", "json-summary"],
    },
  },
});
