// Thin git wrapper over `child_process`. Read-only: never mutates the repo.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AxiError, usageError } from "./errors.js";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 256 * 1024 * 1024;
/** `git diff` target for a repository with no commits yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type DiffStatus = "added" | "modified" | "deleted" | "renamed";

export interface NameStatus {
  /** Path after the change (the old path for a deleted file). */
  path: string;
  /** Previous path, renamed files only. */
  oldPath?: string;
  status: DiffStatus;
}

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run git; resolves with the exit code instead of throwing on non-zero. */
async function run(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
      // LC_ALL=C: stderr is matched below; no optional locks: safe next to a running editor.
      env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (e.code === "ENOENT") {
      throw new AxiError("git is not installed or not on PATH", "GIT_ERROR", [
        "Run `ts-axi impact -` with a unified diff on stdin instead",
      ]);
    }
    if (e.killed) {
      throw new AxiError(`git ${args[0] ?? ""} timed out after ${TIMEOUT_MS / 1000}s`, "GIT_ERROR");
    }
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message,
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

function gitError(result: GitResult, args: string[]): AxiError {
  const first = result.stderr.split("\n").find((l) => l.trim() !== "")?.trim() ?? `git ${args[0]} failed`;
  const message = first.replace(/^(fatal|error): /, "");
  const suggestions = /not a git repository/i.test(first)
    ? ["Run `ts-axi impact -` with a unified diff on stdin instead"]
    : /unknown revision|bad revision|invalid object name|no merge base/i.test(first)
      ? [
          "Run `git branch -a` or `git log --oneline -5` to pick an existing revision",
          "Run `ts-axi impact` for uncommitted changes, or `ts-axi impact <base>...HEAD` for a branch",
        ]
      : [];
  return new AxiError(message, "GIT_ERROR", suggestions);
}

async function runOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await run(cwd, args);
  if (result.code !== 0) throw gitError(result, args);
  return result.stdout;
}

function assertRev(rev: string): void {
  if (rev.startsWith("-")) throw usageError(`invalid git range '${rev}'`);
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const result = await run(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return result.code === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** Top-level directory of the work tree, or `null` outside a repository. */
export async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const result = await run(cwd, ["rev-parse", "--show-toplevel"]);
    const root = result.stdout.trim();
    return result.code === 0 && root !== "" ? root : null;
  } catch {
    return null;
  }
}

/** Branch name; `detached@<sha>` on a detached HEAD; `null` outside a repository. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const branch = await run(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (branch.code === 0 && branch.stdout.trim() !== "") return branch.stdout.trim();
  const sha = await run(cwd, ["rev-parse", "--short", "HEAD"]);
  if (sha.code === 0 && sha.stdout.trim() !== "") return `detached@${sha.stdout.trim()}`;
  return null;
}

/** Files with staged, unstaged or untracked changes. */
export async function dirtyFileCount(cwd: string): Promise<number> {
  const stdout = await runOrThrow(cwd, ["status", "--porcelain"]);
  return stdout.split("\n").filter((l) => l !== "").length;
}

async function diffTarget(cwd: string, range: string | undefined, staged: boolean | undefined): Promise<string[]> {
  if (range !== undefined) {
    assertRev(range);
    return [range];
  }
  if (staged) return ["--cached"];
  const head = await run(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  return [head.code === 0 ? "HEAD" : EMPTY_TREE];
}

function statusOf(letter: string): DiffStatus {
  switch (letter) {
    case "A":
    case "C":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}

/**
 * Changed files. No `range` = working tree vs HEAD (index vs HEAD with
 * `staged`). Untracked files are not part of a diff and are not listed.
 */
export async function diffNameStatus(
  cwd: string,
  range?: string,
  staged?: boolean,
): Promise<NameStatus[]> {
  const target = await diffTarget(cwd, range, staged);
  const stdout = await runOrThrow(cwd, ["diff", "--name-status", "-z", "-M", "--no-color", "--no-ext-diff", ...target, "--"]);
  const tokens = stdout.split("\0");
  const result: NameStatus[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (!code) continue;
    const letter = code.charAt(0);
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i + 1];
      const path = tokens[i + 2];
      i += 2;
      if (oldPath === undefined || path === undefined) break;
      result.push(
        letter === "R" ? { path, oldPath, status: "renamed" } : { path, status: "added" },
      );
    } else {
      const path = tokens[++i];
      if (path === undefined) break;
      result.push({ path, status: statusOf(letter) });
    }
  }
  return result;
}

/** Untracked, not ignored files (repo-root-relative): `git diff` never lists them. */
export async function untrackedFiles(cwd: string): Promise<string[]> {
  const stdout = await runOrThrow(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--full-name", ":/"]);
  return stdout.split("\0").filter((p) => p !== "");
}

/** Raw unified diff with zero context lines; same target rules as `diffNameStatus`. */
export async function diffUnified(cwd: string, range?: string, staged?: boolean): Promise<string> {
  const target = await diffTarget(cwd, range, staged);
  return runOrThrow(cwd, ["diff", "-U0", "--no-color", "--no-ext-diff", "-M", ...target, "--"]);
}

/** File content at `rev`, or `null` when the path does not exist there. */
export async function showFile(cwd: string, rev: string, path: string): Promise<string | null> {
  assertRev(rev);
  const args = ["show", "--no-textconv", `${rev}:${path}`];
  const result = await run(cwd, args);
  if (result.code === 0) return result.stdout;
  if (/path '.*' (does not exist in|exists on disk, but not in)/.test(result.stderr)) return null;
  // No commits yet: nothing exists at HEAD.
  if (rev === "HEAD" && (await run(cwd, ["rev-parse", "--verify", "-q", "HEAD"])).code !== 0) {
    const inRepo = await isGitRepo(cwd);
    if (inRepo) return null;
  }
  throw gitError(result, args);
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string> {
  assertRev(a);
  assertRev(b);
  const stdout = await runOrThrow(cwd, ["merge-base", a, b]);
  return stdout.trim();
}

/**
 * The revision the "before" version of a change lives at, as git computes the
 * diff: `a...b` uses the merge base, `a..b` and a single rev use `a`, no
 * range uses `HEAD`. Lives here (not in diff.ts) because it asks git.
 */
export async function resolveBaseRev(cwd: string, range?: string): Promise<string> {
  if (range === undefined) return "HEAD";
  const triple = range.indexOf("...");
  if (triple > 0) {
    const left = range.slice(0, triple);
    const right = range.slice(triple + 3) || "HEAD";
    return mergeBase(cwd, left, right);
  }
  const double = range.indexOf("..");
  return double > 0 ? range.slice(0, double) : range;
}
