import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AxiError } from "../src/errors.js";
import { createTreeFs, openGitTree, parseBatch, parseLsTree, readBlobs } from "../src/gittree.js";

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });

function repo(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ts-axi-tree-")));
  git(dir, "init", "-q", ".");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

function commit(dir: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "c");
}

function thrown(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (error) {
    return error as AxiError;
  }
  throw new Error("expected a throw");
}

describe("parseLsTree", () => {
  it("parses -z records with odd paths and skips submodules", () => {
    const raw = [
      "100644 blob aaaa\tsrc/with space.ts",
      "100644 blob bbbb\tsrc/ünï.ts",
      "100644 blob cccc\tsrc/new\nline.ts",
      "120000 blob dddd\tsrc/link.ts",
      "160000 commit eeee\tvendor/sub",
      "",
    ].join("\0");
    const entries = parseLsTree(raw);
    expect([...entries.keys()]).toEqual(["src/with space.ts", "src/ünï.ts", "src/new\nline.ts", "src/link.ts"]);
    expect(entries.get("src/link.ts")).toEqual({ mode: "120000", sha: "dddd" });
  });
});

describe("parseBatch", () => {
  it("splits frames by byte length, not by lines", () => {
    const body1 = Buffer.from("line 1\nblob 12\nfake 99 header\n", "utf8");
    const body2 = Buffer.from("ünïcode – ✓", "utf8");
    const raw = Buffer.concat([
      Buffer.from(`aaaa blob ${body1.length}\n`),
      body1,
      Buffer.from("\n"),
      Buffer.from("ffff missing\n"),
      Buffer.from(`bbbb blob ${body2.length}\n`),
      body2,
      Buffer.from("\n"),
    ]);
    const frames = parseBatch(raw);
    expect(frames.get("aaaa")?.toString("utf8")).toBe("line 1\nblob 12\nfake 99 header\n");
    expect(frames.get("ffff")).toBeNull();
    expect(frames.get("bbbb")?.toString("utf8")).toBe("ünïcode – ✓");
  });
});

describe("git tree fs", () => {
  let dir: string;
  beforeAll(() => {
    dir = repo({
      "src/real.ts": "export const real = 1;\n",
      "src/with space.ts": "export const spaced = 1;\n",
      "src/ünï.ts": "export const unicode = 1;\n",
      "src/new\nline.ts": "export const newline = 1;\n",
      "src/sub/deep.ts": "export const deep = 1;\n",
      "outside.ts": "export const outside = 1;\n",
    });
    mkdirSync(join(dir, "src/links"));
    symlinkSync("../real.ts", join(dir, "src/links/to-real.ts"));
    symlinkSync("to-real.ts", join(dir, "src/links/chain.ts"));
    symlinkSync("../../../escape.ts", join(dir, "src/links/escape.ts"));
    symlinkSync("../sub", join(dir, "src/links/dir"));
    symlinkSync("loop-b.ts", join(dir, "src/links/loop-a.ts"));
    symlinkSync("loop-a.ts", join(dir, "src/links/loop-b.ts"));
    commit(dir);
    // A gitlink (submodule) entry without a .gitmodules checkout.
    const head = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "update-index", "--add", "--cacheinfo", `160000,${head},vendor/sub`);
    git(dir, "commit", "-q", "-m", "submodule");
  });

  it("lists files with odd names, follows file symlinks and skips submodules", () => {
    const fs = openGitTree(dir, "HEAD");
    const files = fs.listFiles(dir)!;
    expect(files).toEqual(expect.arrayContaining(["src/real.ts", "src/with space.ts", "src/ünï.ts", "src/new\nline.ts", "src/links/to-real.ts", "src/links/chain.ts"]));
    for (const absent of ["vendor/sub", "src/links/escape.ts", "src/links/dir", "src/links/loop-a.ts", "src/links/loop-b.ts"]) expect(files).not.toContain(absent);
    expect(fs.readFile(join(dir, "src/new\nline.ts"))).toBe("export const newline = 1;\n");
    expect(fs.readFile(join(dir, "src/links/chain.ts"))).toBe("export const real = 1;\n");
    expect(fs.exists(join(dir, "src/links/escape.ts"))).toBe(false);
    expect(fs.isDirectory(join(dir, "src/sub"))).toBe(true);
    expect(fs.isFile(join(dir, "src/sub"))).toBe(false);
    expect(fs.readdir(join(dir, "src")).map((e) => e.name).sort()).toEqual(["links", "new\nline.ts", "real.ts", "sub", "with space.ts", "ünï.ts"].sort());
    expect(fs.realpath(join(dir, "src/./sub/deep.ts"))).toBe(join(dir, "src/sub/deep.ts"));
    expect(fs.ref).toMatchObject({ rev: "HEAD", root: dir, cwd: dir, nodeModulesRead: false });
  });

  it("ignores the working tree: deleted files stay, new files are absent", () => {
    const local = repo({ "a.ts": "export const a = 1;\n" });
    commit(local);
    writeFileSync(join(local, "b.ts"), "export const b = 1;\n");
    execFileSync("rm", [join(local, "a.ts")]);
    const fs = openGitTree(local, "HEAD");
    expect(fs.readFile(join(local, "a.ts"))).toBe("export const a = 1;\n");
    expect(fs.exists(join(local, "b.ts"))).toBe(false);
    expect(fs.listFiles(local)).toEqual(["a.ts"]);
  });

  it("reads node_modules from disk and says so", () => {
    const local = repo({ "a.ts": "export const a = 1;\n" });
    commit(local);
    mkdirSync(join(local, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(local, "node_modules/pkg/index.d.ts"), "export declare const p: number;\n");
    const fs = openGitTree(local, "HEAD");
    expect(fs.ref!.nodeModulesRead).toBe(false);
    expect(fs.readFile(join(local, "node_modules/pkg/index.d.ts"))).toContain("declare const p");
    expect(fs.ref!.nodeModulesRead).toBe(true);
  });

  it("maps a subdirectory cwd into the tree", () => {
    expect(openGitTree(join(dir, "src/sub"), "HEAD").ref!.cwd).toBe(join(dir, "src/sub"));
  });

  it("reads many blobs in one batch", () => {
    const shas = git(dir, "ls-tree", "-r", "HEAD").split("\n").filter((l) => l.includes(" blob ")).map((l) => l.split(/\s+/)[2]!);
    const blobs = readBlobs(dir, shas);
    expect(blobs.size).toBe(new Set(shas).size);
    for (const sha of shas) expect(blobs.get(sha)).toBeInstanceOf(Buffer);
  });

  it("turns a blob missing locally into a clear GIT_ERROR", () => {
    const fake = "0123456789abcdef0123456789abcdef01234567";
    const fs = createTreeFs({ root: dir, cwd: dir, rev: "HEAD", sha: fake, entries: new Map([["gone.ts", { mode: "100644", sha: fake }]]) });
    const error = thrown(() => fs.readFile(join(dir, "gone.ts")));
    expect(error.code).toBe("GIT_ERROR");
    expect(error.message).toBe("blob for gone.ts is not available locally (partial clone?)");
    expect(error.suggestions).toEqual(["Run `git fetch` or use a full clone"]);
  });

  it("rejects bad revisions and non-repositories", () => {
    expect(thrown(() => openGitTree(dir, "no-such-ref")).code).toBe("GIT_ERROR");
    expect(thrown(() => openGitTree(dir, "--output=x")).code).toBe("VALIDATION_ERROR");
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "ts-axi-plain-")));
    expect(thrown(() => openGitTree(plain, "HEAD")).code).toBe("VALIDATION_ERROR");
  });
});
