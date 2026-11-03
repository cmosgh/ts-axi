import { configDefaults, defineConfig } from "vitest/config";

// test/fixtures and test/integration/sample hold analysed sample code (their own tests included), never tests to run.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "test/fixtures/**", "test/integration/sample/**"] },
});
