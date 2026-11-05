import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";

/** The synthetic project, read-only. Run commands in a `fixtureCopy()` instead. */
export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "project");
/** Script-style JavaScript without a tsconfig (AngularJS, Meteor, IIFE, prototype, CommonJS), read-only. */
export const LEGACY_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "legacy-js");
/** CommonJS package without a tsconfig: `require('..')` through an index shim, expando methods, a `.d.ts` twin. */
export const COMMONJS_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "commonjs");
/** `"type": "module"` package without a tsconfig: `index.js` + `index.d.ts`, `test.js` importing `./index.js`. */
export const ESM_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "esm-js");
/** The synthetic Nx + pnpm workspace, read-only. */
export const WORKSPACE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "workspace");

/**
 * A temp copy of the fixture as its own repo root, so paths print as
 * `src/...` and the enclosing repo's `**\/test/**` glob does not apply.
 */
export function fixtureCopy(options: { tsconfig?: boolean; fixture?: string } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ts-axi-fixture-")));
  cpSync(options.fixture ?? FIXTURE, dir, {
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
export const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });

/** A fixture copy committed as one commit. */
export function committed(fixture: string): string {
  const dir = fixtureCopy({ fixture });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Make the working tree disagree with HEAD everywhere: every tracked source shifted by three lines
 * and ending in garbage, one file deleted, untracked decoys declaring the queried names, a new tsconfig.
 */
export function poison(dir: string, names: readonly string[], options: { remove: string; tsconfig: string; tsconfigText: string }): void {
  for (const rel of git(dir, "ls-files").split("\n").filter((f) => SOURCE.test(f))) {
    const abs = join(dir, rel);
    writeFileSync(abs, `const poisoned = 1;\nexport function poisonedDecl() {}\n\n${readFileSync(abs, "utf8")}\n}}} (( garbage\n`);
  }
  rmSync(join(dir, options.remove));
  const decoys = names.map((n) => `export function ${n}(a: number) { return ${n}(a); }\nexport class ${n}Box { ${n}() { return 1; } }`).join("\n");
  for (const rel of ["decoy.ts", "src/decoy.ts", "lib/decoy.js"]) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), decoys.replace(/: number/g, rel.endsWith(".js") ? "" : ": number"));
  }
  mkdirSync(dirname(join(dir, options.tsconfig)), { recursive: true });
  writeFileSync(join(dir, options.tsconfig), options.tsconfigText);
}

