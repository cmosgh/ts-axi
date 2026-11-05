// `--ref <rev>`: a read-only SourceFs over the git tree of one commit (ADR 0003). Files come
// from one `git ls-tree`, contents from batched `git cat-file --batch`; nothing is written,
// checked out or fetched. Paths outside the root or under node_modules fall through to disk.
import { execFileSync } from "node:child_process";
import { posix, resolve, sep } from "node:path";
import { AxiError, usageError } from "./errors.js";
import { diskFs, type DirEntry, type RefInfo, type SourceFs } from "./fs.js";
import { REV_HINT } from "./git.js";

const MODE_LINK = "120000";
const MODE_SUBMODULE = "160000";
const MAX_LINK_HOPS = 8;
/** SHAs per `cat-file --batch` call. */
const BLOB_CHUNK = 2000;
const BLOB_MAX_BUFFER = 1024 * 1024 * 1024;
const SIBLING_PREFETCH = 200;
const TEXTISH = /\.(?:[cm]?[jt]sx?|json|d\.[cm]?ts)$/;

const GIT_ENV = { LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };

interface GitRun {
  stdout: Buffer;
  stderr: string;
  code: number;
}

function git(cwd: string, args: string[], input?: string): GitRun {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      maxBuffer: BLOB_MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
      ...(input !== undefined ? { input } : {}),
    });
    return { stdout, stderr: "", code: 0 };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: Buffer; stderr?: Buffer; status?: number | null };
    if (e.code === "ENOENT") throw new AxiError("git is not installed or not on PATH", "GIT_ERROR", ["--ref reads git objects and needs git"]);
    return { stdout: e.stdout ?? Buffer.alloc(0), stderr: e.stderr?.toString("utf8") ?? e.message, code: e.status ?? 1 };
  }
}

function firstLine(stderr: string): string {
  return (stderr.split("\n").find((l) => l.trim() !== "")?.trim() ?? "git failed").replace(/^(fatal|error): /, "");
}

export interface TreeEntry {
  mode: string;
  sha: string;
}

/** `git ls-tree -r -z` output → path → entry; submodules skipped. */
export function parseLsTree(raw: Buffer | string): Map<string, TreeEntry> {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  const entries = new Map<string, TreeEntry>();
  for (const record of text.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, sha] = record.slice(0, tab).split(" ");
    if (!mode || !sha || mode === MODE_SUBMODULE || type !== "blob") continue;
    entries.set(record.slice(tab + 1), { mode, sha });
  }
  return entries;
}

/** `git cat-file --batch` frames (`<sha> <type> <size>\n<bytes>\n` or `<sha> missing\n`), split by byte length. */
export function parseBatch(raw: Buffer): Map<string, Buffer | null> {
  const result = new Map<string, Buffer | null>();
  let pos = 0;
  while (pos < raw.length) {
    const nl = raw.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = raw.subarray(pos, nl).toString("utf8").split(" ");
    pos = nl + 1;
    const sha = header[0]!;
    if (header[1] === "missing" || header.length < 3) {
      result.set(sha, null);
      continue;
    }
    const size = Number(header[2]);
    result.set(sha, raw.subarray(pos, pos + size));
    pos += size + 1;
  }
  return result;
}

/** Blob contents for `shas` (null = not in the local object store), in chunks of BLOB_CHUNK. */
export function readBlobs(root: string, shas: readonly string[]): Map<string, Buffer | null> {
  const result = new Map<string, Buffer | null>();
  for (let i = 0; i < shas.length; i += BLOB_CHUNK) {
    const chunk = shas.slice(i, i + BLOB_CHUNK);
    const run = git(root, ["cat-file", "--batch"], `${chunk.join("\n")}\n`);
    if (run.code !== 0) throw new AxiError(`git cat-file failed - ${firstLine(run.stderr)}`, "GIT_ERROR");
    for (const [sha, blob] of parseBatch(run.stdout)) result.set(sha, blob);
  }
  return result;
}

export interface TreeFsInit {
  root: string;
  cwd: string;
  rev: string;
  sha: string;
  entries: Map<string, TreeEntry>;
  /** Injectable for tests. */
  read?: (shas: readonly string[]) => Map<string, Buffer | null>;
}

export function createTreeFs(init: TreeFsInit): SourceFs {
  const { root, entries } = init;
  const read = init.read ?? ((shas) => readBlobs(root, shas));
  const children = new Map<string, Map<string, "file" | "dir" | "link">>([["", new Map()]]);
  for (const [path, entry] of entries) {
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const name = parts[i]!;
      let list = children.get(dir);
      if (!list) children.set(dir, (list = new Map()));
      const last = i === parts.length - 1;
      list.set(name, last ? (entry.mode === MODE_LINK ? "link" : "file") : "dir");
      if (!last) {
        const sub = parts.slice(0, i + 1).join("/");
        if (!children.has(sub)) children.set(sub, new Map());
      }
    }
  }
  const texts = new Map<string, string>();
  const links = new Map<string, string | undefined>();
  const ref: RefInfo = { rev: init.rev, sha: init.sha, root, cwd: init.cwd, nodeModulesRead: false };

  /** Repo-relative path for an absolute one; undefined = outside the tree or under node_modules (disk). */
  const relOf = (abs: string): string | undefined => {
    const p = resolve(abs);
    if (p === root) return "";
    if (!p.startsWith(root + sep)) return undefined;
    const rel = p.slice(root.length + 1).split(sep).join("/");
    return rel.split("/").includes("node_modules") ? undefined : rel;
  };

  const load = (shas: string[], paths: Map<string, string>): void => {
    const todo = [...new Set(shas.filter((s) => !texts.has(s)))];
    if (todo.length === 0) return;
    for (const [sha, blob] of read(todo)) {
      if (blob === null) {
        throw new AxiError(`blob for ${paths.get(sha) ?? sha} is not available locally (partial clone?)`, "GIT_ERROR", [
          "Run `git fetch` or use a full clone",
        ]);
      }
      texts.set(sha, blob.toString("utf8"));
    }
  };

  /** A symlink's target inside the tree (file paths only); undefined when it leaves the tree or loops. */
  const resolveLink = (rel: string, hops = 0): string | undefined => {
    if (links.has(rel)) return links.get(rel);
    let target: string | undefined;
    const entry = entries.get(rel);
    if (entry && hops < MAX_LINK_HOPS) {
      load([entry.sha], new Map([[entry.sha, rel]]));
      const raw = texts.get(entry.sha)!;
      const joined = raw.startsWith("/") ? relOf(raw) : posix.normalize(posix.join(posix.dirname(rel), raw));
      if (joined !== undefined && !joined.startsWith("../") && joined !== "..") {
        const next = entries.get(joined);
        target = next?.mode === MODE_LINK ? resolveLink(joined, hops + 1) : next ? joined : undefined;
      }
    }
    links.set(rel, target);
    return target;
  };

  /** The regular-file entry behind `rel` (following symlinks). */
  const fileEntry = (rel: string): { rel: string; entry: TreeEntry } | undefined => {
    const entry = entries.get(rel);
    if (!entry) return undefined;
    if (entry.mode !== MODE_LINK) return { rel, entry };
    const target = resolveLink(rel);
    return target === undefined ? undefined : { rel: target, entry: entries.get(target)! };
  };

  const prefetchRels = (rels: readonly string[]): void => {
    const shas: string[] = [];
    const paths = new Map<string, string>();
    for (const rel of rels) {
      const hit = fileEntry(rel);
      if (!hit || texts.has(hit.entry.sha)) continue;
      shas.push(hit.entry.sha);
      paths.set(hit.entry.sha, hit.rel);
    }
    load(shas, paths);
  };

  const fs: SourceFs = {
    ref,
    exists(abs) {
      const rel = relOf(abs);
      if (rel === undefined) return diskFs.exists(abs);
      return children.has(rel) || fileEntry(rel) !== undefined;
    },
    isFile(abs) {
      const rel = relOf(abs);
      if (rel === undefined) return diskFs.isFile(abs);
      return fileEntry(rel) !== undefined;
    },
    isDirectory(abs) {
      const rel = relOf(abs);
      if (rel === undefined) return diskFs.isDirectory(abs);
      return children.has(rel);
    },
    readFile(abs) {
      const rel = relOf(abs);
      if (rel === undefined) {
        const text = diskFs.readFile(abs);
        if (text !== undefined && resolve(abs).startsWith(root + sep)) ref.nodeModulesRead = true;
        return text;
      }
      const hit = fileEntry(rel);
      if (!hit) return undefined;
      if (!texts.has(hit.entry.sha)) {
        // A single miss loads its source-ish siblings too: TS resolution reads neighbours next.
        const dir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
        const siblings = [...(children.get(dir)?.entries() ?? [])]
          .filter(([name, type]) => type === "file" && TEXTISH.test(name))
          .slice(0, SIBLING_PREFETCH)
          .map(([name]) => (dir ? `${dir}/${name}` : name));
        prefetchRels([rel, ...siblings]);
      }
      return texts.get(hit.entry.sha);
    },
    readdir(abs) {
      const rel = relOf(abs);
      if (rel === undefined) return diskFs.readdir(abs);
      const list = children.get(rel);
      if (!list) return [];
      return [...list].map(([name, type]): DirEntry => ({ name, isFile: type === "file", isDirectory: type === "dir" }));
    },
    realpath(abs) {
      const rel = relOf(abs);
      if (rel === undefined) return diskFs.realpath(abs);
      if (!fs.exists(abs)) throw new Error(`ENOENT: ${abs}`);
      return resolve(abs);
    },
    listFiles(listRoot) {
      if (resolve(listRoot) !== root) return undefined;
      const linked = [...entries].filter(([, e]) => e.mode === MODE_LINK).map(([p]) => p);
      if (linked.length > 0) {
        const shas = linked.map((p) => entries.get(p)!.sha);
        load(shas, new Map(linked.map((p) => [entries.get(p)!.sha, p])));
      }
      return [...entries.keys()].filter((p) => entries.get(p)!.mode !== MODE_LINK || resolveLink(p) !== undefined);
    },
    prefetch(abs) {
      const rels: string[] = [];
      for (const a of abs) {
        const rel = relOf(a);
        if (rel !== undefined) rels.push(rel);
      }
      prefetchRels(rels);
    },
  };
  return fs;
}

/** Resolve `rev` once (pinned SHA), list its tree, and return the SourceFs for it. */
export function openGitTree(cwd: string, rev: string): SourceFs {
  if (rev.startsWith("-")) throw usageError(`invalid --ref '${rev}'`, ["pass a revision such as origin/main, HEAD~3 or a SHA"]);
  const where = git(cwd, ["rev-parse", "--show-toplevel", "--show-prefix"]);
  if (where.code !== 0) {
    throw usageError(`--ref needs a git repository - ${firstLine(where.stderr)}`, ["Run ts-axi inside a git checkout, or drop --ref"]);
  }
  const [toplevel = "", prefix = ""] = where.stdout.toString("utf8").split("\n");
  const commit = git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  const sha = commit.stdout.toString("utf8").trim();
  if (commit.code !== 0 || sha === "") {
    throw new AxiError(`unknown revision '${rev}'`, "GIT_ERROR", [REV_HINT]);
  }
  const listed = git(cwd, ["ls-tree", "-r", "-z", "--full-tree", sha]);
  if (listed.code !== 0) throw new AxiError(`git ls-tree failed - ${firstLine(listed.stderr)}`, "GIT_ERROR");
  const root = resolve(toplevel);
  return createTreeFs({ root, cwd: resolve(root, prefix), rev, sha, entries: parseLsTree(listed.stdout) });
}
