import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { baseRevOfRange, changedRanges, parseUnifiedDiff } from "../src/diff.js";
import {
  currentBranch,
  diffNameStatus,
  diffUnified,
  dirtyFileCount,
  gitRoot,
  isGitRepo,
  mergeBase,
  resolveBaseRev,
  showFile,
} from "../src/git.js";
import { DEFAULT_TEST_GLOBS, isTestFile, loadSettings, readSettingsFile, writeSettingsFile } from "../src/settings.js";
import { configCommand } from "../src/commands/config.js";

let dir: string;
beforeEach(() => {
  // realpath-free: macOS tmpdir is a symlink, so compare via loadSettings().root only.
  dir = mkdtempSync(join(tmpdir(), "ts-axi-unit-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function settingsFile(data: unknown): void {
  writeFileSync(join(dir, ".ts-axi.json"), JSON.stringify(data));
}

describe("loadSettings", () => {
  it("uses the defaults when no file exists", () => {
    const s = loadSettings(dir);
    expect(s.testGlobs).toEqual([...DEFAULT_TEST_GLOBS]);
    expect(s.sources.testGlobs.every((x) => x === "default")).toBe(true);
    expect(s.project).toBeUndefined();
    expect(s.sources.project).toBe("default");
  });

  it("adds file and flag globs to the defaults with provenance", () => {
    settingsFile({ testGlobs: ["**/*.it.ts"], project: "tsconfig.app.json" });
    const s = loadSettings(dir, { testGlobs: ["qa/**"] });
    expect(s.testGlobs).toEqual([...DEFAULT_TEST_GLOBS, "**/*.it.ts", "qa/**"]);
    expect(s.sources.testGlobs.slice(-2)).toEqual([".ts-axi.json", "flag"]);
    expect(s.project).toBe("tsconfig.app.json");
    expect(s.sources.project).toBe(".ts-axi.json");
  });

  it("drops the defaults when testGlobsReplace is set", () => {
    settingsFile({ testGlobs: ["**/*.it.ts"], testGlobsReplace: true });
    const s = loadSettings(dir, { testGlobs: ["qa/**"] });
    expect(s.testGlobs).toEqual(["**/*.it.ts", "qa/**"]);
    expect(s.testGlobsReplace).toBe(true);
  });

  it("lets -P win over the file and dedupes repeated globs", () => {
    settingsFile({ testGlobs: ["**/*.test.*"], project: "a.json" });
    const s = loadSettings(dir, { project: "b.json" });
    expect(s.project).toBe("b.json");
    expect(s.sources.project).toBe("flag");
    expect(s.testGlobs.filter((g) => g === "**/*.test.*")).toHaveLength(1);
    expect(s.sources.testGlobs[0]).toBe("default");
  });

  it("puts the root at the nearest .git above cwd", () => {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "pkg", "src"), { recursive: true });
    expect(loadSettings(join(dir, "pkg", "src")).root).toBe(loadSettings(dir).root);
  });

  it("rejects unknown keys and wrong types naming the valid keys", () => {
    settingsFile({ testGlob: ["x"] });
    expect(() => loadSettings(dir)).toThrowError(/unknown key 'testGlob'/);
    try {
      loadSettings(dir);
    } catch (error) {
      expect((error as { code: string }).code).toBe("VALIDATION_ERROR");
      expect((error as { suggestions: string[] }).suggestions[0]).toContain("testGlobs, testGlobsReplace, project");
    }
    settingsFile({ testGlobs: "x" });
    expect(() => loadSettings(dir)).toThrowError(/'testGlobs' must be an array/);
    settingsFile({ testGlobsReplace: "yes" });
    expect(() => loadSettings(dir)).toThrowError(/'testGlobsReplace' must be a boolean/);
    settingsFile({ project: 3 });
    expect(() => loadSettings(dir)).toThrowError(/'project' must be a non-empty string/);
    writeFileSync(join(dir, ".ts-axi.json"), "{ nope");
    expect(() => loadSettings(dir)).toThrowError(/not valid JSON/);
  });

  it("writes pretty JSON with a trailing newline", () => {
    writeSettingsFile(dir, { testGlobs: ["a/**"] });
    expect(readFileSync(join(dir, ".ts-axi.json"), "utf-8")).toBe('{\n  "testGlobs": [\n    "a/**"\n  ]\n}\n');
    expect(readSettingsFile(dir)).toEqual({ testGlobs: ["a/**"] });
    expect(readSettingsFile(join(dir, "missing"))).toBeUndefined();
  });
});

describe("isTestFile", () => {
  it("matches the default globs", () => {
    const s = loadSettings(dir);
    for (const p of [
      "src/a.test.ts",
      "src/a.spec.tsx",
      "src/__tests__/a.ts",
      "test/a.ts",
      "packages/x/tests/a.ts",
      "e2e/login.ts",
    ]) {
      expect(isTestFile(p, s), p).toBe(true);
    }
    for (const p of ["src/a.ts", "src/testing-utils.ts", "contest/a.ts"]) {
      expect(isTestFile(p, s), p).toBe(false);
    }
  });

  it("honours custom and replacing globs", () => {
    settingsFile({ testGlobs: ["**/*.it.ts"] });
    expect(isTestFile("src/a.it.ts", loadSettings(dir))).toBe(true);
    expect(isTestFile("src/a.test.ts", loadSettings(dir))).toBe(true);
    settingsFile({ testGlobs: ["**/*.it.ts"], testGlobsReplace: true });
    expect(isTestFile("src/a.it.ts", loadSettings(dir))).toBe(true);
    expect(isTestFile("src/a.test.ts", loadSettings(dir))).toBe(false);
    expect(isTestFile("src/a.ts", loadSettings(dir, { testGlobs: ["src/**"] }))).toBe(true);
  });
});

describe("config command", () => {
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  it("sets, dedupes, replaces and unsets", async () => {
    process.chdir(dir);
    expect(await configCommand(["set", "test-globs", "**/*.it.ts"])).toContain("test_globs: updated");
    expect(await configCommand(["set", "test-globs", "**/*.it.ts"])).toContain("(no-op)");
    expect(await configCommand(["set", "test-globs", "**/*.test.*"])).toContain("(no-op)");
    const shown = await configCommand([]);
    expect(shown).toContain("test_globs[7]{glob,source}:");
    expect(shown).toContain("**/*.it.ts,.ts-axi.json");
    expect(shown).toContain("project: none");

    expect(await configCommand(["set", "test-globs", "qa/**", "--replace"])).toContain("test_globs: replaced");
    expect(readSettingsFile(dir)).toEqual({ testGlobs: ["qa/**"], testGlobsReplace: true });

    writeFileSync(join(dir, "tsconfig.app.json"), "{}");
    expect(await configCommand(["set", "project", "./tsconfig.app.json"])).toContain("project: tsconfig.app.json");
    expect(readSettingsFile(dir)?.project).toBe("tsconfig.app.json");
    await expect(configCommand(["set", "project", "nope.json"])).rejects.toThrowError(/not found/);

    expect(await configCommand(["unset", "test-globs"])).toContain("test_globs: unset");
    expect(readSettingsFile(dir)).toEqual({ project: "tsconfig.app.json" });
    expect(await configCommand(["unset", "test-globs"])).toContain("(no-op)");
  });

  it("rejects unknown keys with the valid set", async () => {
    process.chdir(dir);
    await expect(configCommand(["set", "colour", "x"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      suggestions: ["valid keys: test-globs, project"],
    });
  });
});

describe("parseUnifiedDiff", () => {
  it("parses a modified file with -U0 hunks", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3 +3,2 @@ function f()",
      "-  return 1;",
      "+  const x = 1;",
      "+  return x;",
      "@@ -10,2 +11,0 @@",
      "-a",
      "-b",
      "",
    ].join("\n");
    const [file, ...rest] = parseUnifiedDiff(diff);
    expect(rest).toEqual([]);
    expect(file).toMatchObject({ path: "src/a.ts", oldPath: undefined, status: "modified" });
    expect(file!.hunks).toHaveLength(2);
    expect(file!.hunks[0]).toEqual({
      oldStart: 3,
      oldLines: 1,
      newStart: 3,
      newLines: 2,
      removed: [{ line: 3, text: "  return 1;" }],
      added: [
        { line: 3, text: "  const x = 1;" },
        { line: 4, text: "  return x;" },
      ],
    });
    expect(file!.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 2, newStart: 11, newLines: 0 });
    expect(file!.hunks[1]!.removed.map((l) => l.line)).toEqual([10, 11]);
    expect(changedRanges(file!)).toEqual({ after: [[3, 4]], before: [[3, 3], [10, 11]] });
  });

  it("handles added, deleted and renamed files, skipping binaries", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-gone",
      "-gone2",
      "diff --git a/img.png b/img.png",
      "index 1111111..2222222 100644",
      "Binary files a/img.png and b/img.png differ",
      "diff --git a/src/x.ts b/src/y.ts",
      "similarity index 90%",
      "rename from src/x.ts",
      "rename to src/y.ts",
      "index 1111111..2222222 100644",
      "--- a/src/x.ts",
      "+++ b/src/y.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/p.ts b/q.ts",
      "similarity index 100%",
      "rename from p.ts",
      "rename to q.ts",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => [f.path, f.oldPath, f.status])).toEqual([
      ["new.ts", undefined, "added"],
      ["old.ts", undefined, "deleted"],
      ["src/y.ts", "src/x.ts", "renamed"],
      ["q.ts", "p.ts", "renamed"],
    ]);
    expect(changedRanges(files[0]!)).toEqual({ after: [[1, 2]], before: [] });
    expect(changedRanges(files[1]!)).toEqual({ after: [], before: [[1, 2]] });
    expect(files[3]!.hunks).toEqual([]);
  });

  it("ignores '\\ No newline at end of file' and does not mistake '-- x' content for headers", () => {
    const diff = [
      "diff --git a/a.sql b/a.sql",
      "--- a/a.sql",
      "+++ b/a.sql",
      "@@ -1,2 +1,2 @@",
      "--- comment",
      "\\ No newline at end of file",
      "+++ comment2",
      "\\ No newline at end of file",
      " ctx",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]!.hunks[0]!.removed).toEqual([{ line: 1, text: "-- comment" }]);
    expect(files[0]!.hunks[0]!.added).toEqual([{ line: 1, text: "++ comment2" }]);
  });

  it("accepts plain bb-axi-style output without 'diff --git' lines and with context", () => {
    const diff = [
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1,4 +1,5 @@",
      " keep",
      "-old",
      "+new",
      "+extra",
      " keep2",
      " keep3",
      "--- a/src/two.ts",
      "+++ b/src/two.ts",
      "@@ -5 +5 @@",
      "-x",
      "+y",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["src/one.ts", "src/two.ts"]);
    expect(changedRanges(files[0]!)).toEqual({ after: [[2, 3]], before: [[2, 2]] });
    expect(changedRanges(files[1]!)).toEqual({ after: [[5, 5]], before: [[5, 5]] });
  });

  it("decodes quoted paths and returns [] for empty input", () => {
    const diff = ['diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"', '--- "a/caf\\303\\251.ts"', '+++ "b/caf\\303\\251.ts"', "@@ -1 +1 @@", "-a", "+b"].join("\n");
    expect(parseUnifiedDiff(diff)[0]!.path).toBe("café.ts");
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("changedRanges", () => {
  it("merges adjacent lines and sorts", () => {
    const [file] = parseUnifiedDiff(
      ["--- a/f.ts", "+++ b/f.ts", "@@ -0,0 +9,2 @@", "+a", "+b", "@@ -0,0 +2 @@", "+c", "@@ -0,0 +4 @@", "+d"].join("\n"),
    );
    expect(changedRanges(file!).after).toEqual([[2, 2], [4, 4], [9, 10]]);
  });
});

describe("baseRevOfRange", () => {
  it("returns the left side of the range", () => {
    expect(baseRevOfRange("main...HEAD")).toBe("main");
    expect(baseRevOfRange("a..b")).toBe("a");
    expect(baseRevOfRange("abc123")).toBe("abc123");
    expect(baseRevOfRange("v1.0..v2.0")).toBe("v1.0");
    expect(baseRevOfRange("...HEAD")).toBe("HEAD");
    expect(baseRevOfRange(undefined)).toBe("HEAD");
  });
});

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!gitAvailable())("git helpers", () => {
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      encoding: "utf8",
    });

  beforeEach(() => {
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.ts"), "export function f() {\n  return 1;\n}\n");
    writeFileSync(join(dir, "gone.ts"), "export const g = 1;\n");
    writeFileSync(join(dir, "move.ts"), "export const m = 1;\nexport const n = 2;\nexport const o = 3;\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
  });

  it("reports repo state", async () => {
    expect(await isGitRepo(dir)).toBe(true);
    expect(await isGitRepo(tmpdir())).toBe(false);
    expect(await gitRoot(dir)).not.toBeNull();
    expect(await currentBranch(dir)).toBe("main");
    expect(await dirtyFileCount(dir)).toBe(0);
    writeFileSync(join(dir, "untracked.ts"), "");
    writeFileSync(join(dir, "a.ts"), "export function f() {\n  return 2;\n}\n");
    expect(await dirtyFileCount(dir)).toBe(2);
  });

  it("lists and diffs working-tree, staged and ranged changes", async () => {
    writeFileSync(join(dir, "a.ts"), "export function f() {\n  return 2;\n}\n");
    git("rm", "-q", "gone.ts");
    git("mv", "move.ts", "moved.ts");
    writeFileSync(join(dir, "fresh.ts"), "export const z = 1;\n");
    git("add", "fresh.ts");

    const all = await diffNameStatus(dir);
    expect(all).toEqual(
      expect.arrayContaining([
        { path: "a.ts", status: "modified" },
        { path: "gone.ts", status: "deleted" },
        { path: "moved.ts", oldPath: "move.ts", status: "renamed" },
        { path: "fresh.ts", status: "added" },
      ]),
    );

    const parsed = parseUnifiedDiff(await diffUnified(dir));
    const a = parsed.find((f) => f.path === "a.ts")!;
    expect(changedRanges(a)).toEqual({ after: [[2, 2]], before: [[2, 2]] });

    const staged = await diffNameStatus(dir, undefined, true);
    expect(staged.map((s) => s.path).sort()).toEqual(["fresh.ts", "gone.ts", "moved.ts"]);
    expect(staged.find((s) => s.path === "a.ts")).toBeUndefined();

    git("commit", "-q", "-am", "second");
    git("switch", "-q", "-c", "feature");
    writeFileSync(join(dir, "a.ts"), "export function f() {\n  return 3;\n}\n");
    git("commit", "-q", "-am", "feature change");
    git("switch", "-q", "main");
    writeFileSync(join(dir, "other.ts"), "export const o = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "main moves on");

    const base = await mergeBase(dir, "main", "feature");
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(await resolveBaseRev(dir, "main...feature")).toBe(base);
    expect(await resolveBaseRev(dir, "main..feature")).toBe("main");
    expect(await resolveBaseRev(dir)).toBe("HEAD");
    expect((await diffNameStatus(dir, "main...feature")).map((s) => s.path)).toEqual(["a.ts"]);
  });

  it("reads files at a revision and returns null when absent", async () => {
    expect(await showFile(dir, "HEAD", "a.ts")).toBe("export function f() {\n  return 1;\n}\n");
    expect(await showFile(dir, "HEAD", "nope.ts")).toBeNull();
  });

  it("raises GIT_ERROR with a stdin hint outside a repository", async () => {
    await expect(dirtyFileCount(tmpdir())).rejects.toMatchObject({
      code: "GIT_ERROR",
      suggestions: ["Run `ts-axi impact -` with a unified diff on stdin instead"],
    });
    await expect(diffUnified(dir, "no-such-rev")).rejects.toMatchObject({ code: "GIT_ERROR" });
    await expect(showFile(dir, "no-such-rev", "a.ts")).rejects.toMatchObject({ code: "GIT_ERROR" });
  });
});
