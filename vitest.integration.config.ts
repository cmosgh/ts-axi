import { defineConfig } from "vitest/config";

// Opt-in: drives the built CLI (dist/) against the vendored sample in a temp git repo.
export default defineConfig({
  test: {
    include: ["test/integration/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
