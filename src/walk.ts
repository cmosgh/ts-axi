// The one file listing for every walk (implicit project, home count, workspace detection,
// importer index, outside-project search): `git ls-files` inside a repo, else an fs walk with
// one skip rule. Node builtins only: the home view imports it.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

/** Build output, dependencies, caches and tool/editor state (agent worktrees live in `.claude/`). */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules", "dist", "build", "coverage", "tmp", ".git", ".nx", ".angular", ".claude", ".cursor", ".idea", ".vscode",
]);

/** A directory below the root that holds its own `.git` (nested repo or worktree) is another checkout. */
export function isNestedCheckout(dir: string, root: string): boolean {
  return dir !== root && existsSync(join(dir, ".git"));
}

export function skipDir(name: string, path: string, root: string): boolean {
  return SKIP_DIRS.has(name) || isNestedCheckout(path, root);
}

export interface WalkOptions {
  /** Stop after this many accepted files. */
  maxFiles?: number;
  /** Absolute `Date.now()` deadline. */
  deadline?: number;
  accept: (name: string) => boolean;
  /** Breadth-first, entries sorted by name: shallow paths come first. */
  breadthFirst?: boolean;
}

/** Files below `root` (absolute paths) under the shared skip rule; `capped` when a bound stopped it. */
export function walkFiles(root: string, options: WalkOptions): { files: string[]; capped: boolean } {
  const files: string[] = [];
  const queue = [root];
  let capped = false;
  while (queue.length > 0) {
    if ((options.maxFiles !== undefined && files.length >= options.maxFiles) || (options.deadline !== undefined && Date.now() > options.deadline)) {
      capped = true;
      break;
    }
    const dir = options.breadthFirst ? queue.shift()! : queue.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (options.breadthFirst) entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDir(entry.name, path, root)) queue.push(path);
      } else if (entry.isFile() && options.accept(entry.name)) {
        files.push(path);
      }
    }
  }
  return { files, capped };
}

/** Shortest path first, then alphabetical: the canonical copy before nested duplicates. */
export function byDepthThenPath(a: string, b: string): number {
  return a.split("/").length - b.split("/").length || a.localeCompare(b);
}

/**
 * Tracked + untracked-not-ignored files, repo-relative (one local, read-only `git ls-files` call):
 * git never descends into nested repos or worktrees, and gitignored dirs drop out. Undefined
 * when `root` is not a git checkout (`.git` dir, or file for a linked worktree) or git is missing.
 */
export function gitFiles(root: string): string[] | undefined {
  if (!existsSync(join(root, ".git"))) return undefined;
  try {
    const raw = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // A nested repo shows up as one `dir/` entry; deleted-but-tracked files are dropped by the caller's accept/exists check.
    return [...new Set(raw.split("\0").filter((f) => f !== "" && !f.endsWith("/")))];
  } catch {
    return undefined;
  }
}

export interface Listing {
  /** Absolute paths, sorted. */
  files: string[];
  capped: boolean;
  listedBy: "git" | "walk";
}

/**
 * Files below `root` whose basename passes `accept`: the git listing (skip-dir segments removed,
 * missing files dropped) or, outside git, the bounded fs walk.
 */
export function listFiles(root: string, accept: (name: string) => boolean, bounds: Omit<WalkOptions, "accept" | "breadthFirst"> = {}): Listing {
  const git = gitFiles(root);
  if (git) {
    const files = git
      .filter((f) => accept(f.slice(f.lastIndexOf("/") + 1)) && !f.split("/").some((seg) => SKIP_DIRS.has(seg)))
      .map((f) => join(root, f))
      .filter((f) => existsSync(f))
      .sort();
    return { files, capped: false, listedBy: "git" };
  }
  const walked = walkFiles(root, { ...bounds, accept });
  return { files: walked.files.sort(), capped: walked.capped, listedBy: "walk" };
}

export function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}
