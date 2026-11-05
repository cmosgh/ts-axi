// The file-system seam: every read of repo content goes through `sourceFs()`. `diskFs` is the
// working tree; `--ref` swaps in a git-tree view (src/gittree.ts). Node builtins only.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

/** What `--ref` pinned, for the output header. */
export interface RefInfo {
  rev: string;
  sha: string;
  /** Repo root (`git rev-parse --show-toplevel`). */
  root: string;
  /** Logical cwd inside the tree (root + `--show-prefix`). */
  cwd: string;
  /** Set once a node_modules file was read from the working tree. */
  nodeModulesRead: boolean;
}

export interface SourceFs {
  exists(abs: string): boolean;
  isFile(abs: string): boolean;
  isDirectory(abs: string): boolean;
  /** UTF-8 text; undefined when absent or unreadable. */
  readFile(abs: string): string | undefined;
  /** Entries of a directory; [] when absent. Symlinks are neither file nor directory (like `Dirent`). */
  readdir(abs: string): DirEntry[];
  /** Throws when absent (like `realpathSync`). */
  realpath(abs: string): string;
  /** Tracked + untracked-not-ignored files below a repo root, repo-relative; undefined outside git. */
  listFiles(root: string): string[] | undefined;
  /** Hint that these files are about to be read (batch loading); no-op on disk. */
  prefetch(abs: readonly string[]): void;
  ref?: RefInfo;
}

export const diskFs: SourceFs = {
  exists: (abs) => existsSync(abs),
  isFile(abs) {
    try {
      return statSync(abs).isFile();
    } catch {
      return false;
    }
  },
  isDirectory(abs) {
    try {
      return statSync(abs).isDirectory();
    } catch {
      return false;
    }
  },
  readFile(abs) {
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return undefined;
    }
  },
  readdir(abs) {
    try {
      return readdirSync(abs, { withFileTypes: true }).map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }));
    } catch {
      return [];
    }
  },
  realpath: (abs) => realpathSync(abs),
  listFiles(root) {
    if (!existsSync(join(root, ".git"))) return undefined;
    try {
      const raw = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // A nested repo shows up as one `dir/` entry; deleted-but-tracked files are dropped by the caller's exists check.
      return [...new Set(raw.split("\0").filter((f) => f !== "" && !f.endsWith("/")))];
    } catch {
      return undefined;
    }
  },
  prefetch: () => {},
};

// One fs per run, set by the command that parsed `--ref` and reset by `main()`. A module-level
// value because the reads sit in ~40 free functions (tsconfig chains, workspace detection, TS hosts).
let active: SourceFs = diskFs;

export function sourceFs(): SourceFs {
  return active;
}

export function setSourceFs(fs: SourceFs): void {
  active = fs;
}
