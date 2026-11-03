import { configDefaults, defineConfig } from "vitest/config";

// test/fixtures and test/integration/sample hold analysed sample code (their own tests included), never tests to run;
// test/integration/*.test.ts is the opt-in suite behind `pnpm run test:integration`.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "test/fixtures/**", "test/integration/sample/**", "test/integration/*.test.ts"] },
});
