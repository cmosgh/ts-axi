import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SAMPLE = join(HERE, "sample");
export const CLI = join(REPO, "dist", "bin", "ts-axi.js");
const SKIP_COPY = new Set(["node_modules", "dist", ".astro"]);

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface Sample {
  /** Temp git repo (branch main, one commit `base`) holding a copy of the sample. */
  dir: string;
  /** Run the built CLI in `dir`. Never rejects on a non-zero exit. */
  run(...argv: string[]): Promise<CliResult>;
  /** `run(...argv, "--json")`, stdout parsed. */
  runJson(...argv: string[]): Promise<Record<string, unknown>>;
  /** Run git in `dir` with the test identity; resolves to stdout. */
  git(...args: string[]): Promise<string>;
  /** Write `content` to `relPath` in `dir`, creating parent folders. */
  write(relPath: string, content: string): void;
  cleanup(): void;
}

let installed: Promise<void> | undefined;

/** The sample's dependencies are installed once, on first use (needs network). */
function ensureSampleModules(): Promise<void> {
  installed ??= (async () => {
    if (existsSync(join(SAMPLE, "node_modules"))) return;
    await execFileAsync("corepack", ["pnpm", "install", "--frozen-lockfile"], { cwd: SAMPLE, maxBuffer: 64 * 1024 * 1024 });
  })();
  return installed;
}

async function gitIn(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * Copy the sample into a temp repo. In place, the enclosing ts-axi repo would be the git root, so
 * paths would carry `test/integration/sample/` and the default `**\/test/**` glob would mark every file a test.
 */
export async function prepareSample(): Promise<Sample> {
  await ensureSampleModules();
  return prepareCopy(SAMPLE, join(SAMPLE, "node_modules"));
}

/** `prepareSample()` for a fixture without dependencies, e.g. `test/fixtures/legacy-js`. */
export function prepareFixture(src: string): Promise<Sample> {
  return prepareCopy(src);
}

async function prepareCopy(src: string, modules?: string): Promise<Sample> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ts-axi-sample-")));
  cpSync(src, dir, {
    recursive: true,
    filter: (path) => !SKIP_COPY.has(relative(src, path).split(sep)[0] ?? ""),
  });
  if (modules) symlinkSync(modules, join(dir, "node_modules"), "dir");
  await gitIn(dir, ["init", "-q", "-b", "main"]);
  await gitIn(dir, ["add", "-A"]);
  await gitIn(dir, ["commit", "-q", "-m", "base"]);

  const run = async (...argv: string[]): Promise<CliResult> => {
    try {
      const { stdout, stderr } = await execFileAsync("node", [CLI, ...argv], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; code?: number | string };
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: typeof e.code === "number" ? e.code : 1 };
    }
  };

  return {
    dir,
    run,
    runJson: async (...argv) => JSON.parse((await run(...argv, "--json")).stdout) as Record<string, unknown>,
    git: (...args) => gitIn(dir, args),
    write(relPath, content) {
      const file = join(dir, relPath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Decode the TOON part of stdout, i.e. everything before a `---` code fence. */
export function decodeToon(stdout: string): Record<string, unknown> {
  const fence = stdout.indexOf("\n---\n");
  const head = fence === -1 ? stdout : stdout.slice(0, fence);
  return decode(head, { strict: true }) as Record<string, unknown>;
}
