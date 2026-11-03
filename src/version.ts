// Leaf module: imports node builtins only, never the command graph.
// `bin/ts-axi.ts` imports this on the `--version` fast path, so any new import
// here would be paid on every invocation of that path.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/version.ts (dev) sits one level below package.json; dist/src/version.js two.
  for (const candidate of [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    if (!existsSync(candidate)) continue;
    const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (parsed.name === "ts-axi" && typeof parsed.version === "string") {
      return parsed.version;
    }
  }
  throw new Error("Could not determine ts-axi package version");
}

export const VERSION = readPackageVersion();
