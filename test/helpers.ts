import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";

/** The synthetic project, read-only. Run commands in a `fixtureCopy()` instead. */
export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "project");

/**
 * A temp copy of the fixture as its own repo root, so paths print as
 * `src/...` and the enclosing repo's `**\/test/**` glob does not apply.
 */
export function fixtureCopy(options: { tsconfig?: boolean } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ts-axi-fixture-")));
  cpSync(FIXTURE, dir, {
    recursive: true,
    filter: (src) => options.tsconfig !== false || !src.endsWith("tsconfig.json"),
  });
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir, stdio: "ignore" });
  } catch {
    mkdirSync(join(dir, ".git"));
  }
  return dir;
}

export interface RunResult {
  stdout: string;
  exitCode: number;
}

/** Run the whole CLI through `main()` in `cwd`. */
export async function runIn(cwd: string, ...argv: string[]): Promise<RunResult> {
  let stdout = "";
  process.exitCode = 0;
  await main({ argv, cwd, stdout: { write: (chunk: string) => (stdout += chunk) } });
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { stdout, exitCode };
}

/** `runIn()` bound to one directory: `const run = runner(dir); await run("def", "User")`. */
export function runner(cwd: string): (...argv: string[]) => Promise<RunResult> {
  return (...argv) => runIn(cwd, ...argv);
}
