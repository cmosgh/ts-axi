import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { judge, lineCount, looksLikeAnchor, parseAnchor } from "../src/anchor.js";
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
import { classifyReferenceGroups, viaLine, type GroupDescriptor, type RefDescriptor } from "../src/references.js";
import {
  allocateBudget,
  classifyFile,
  compareChanges,
  formatRanges,
  innermost,
  liftTypeLevel,
  localOnlyLine,
  mapRanges,
  rankOf,
  reverseApply,
  signatures,
  wordMatches,
  type FileInput,
} from "../src/impact.js";
import { parseSource, type SyntacticIndex } from "../src/project.js";
import { isPlainLocal } from "../src/commands/impact.js";
import { collectDeclarations, registrationOf } from "../src/symbols.js";
import { matchRows, MATCH_ROWS, narrowHints } from "../src/commands/common.js";
import { groupSymbols } from "../src/symbols.js";
import { kebab, templateTarget, usagesIn } from "../src/templates.js";

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
    expect(shown).toContain("test_globs[10]{glob,source}:");
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
      context: [],
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

  it("keeps context lines with their number on both sides", () => {
    const diff = [
      "--- a/m.ts",
      "+++ b/m.ts",
      "@@ -4,6 +4,7 @@ class Box",
      " one",
      " two",
      "-three",
      "+THREE",
      "+three-and-a-half",
      " four",
      "",
      " six",
    ].join("\n");
    const [file] = parseUnifiedDiff(diff);
    const hunk = file!.hunks[0]!;
    expect(hunk.context).toEqual([
      { oldLine: 4, newLine: 4 },
      { oldLine: 5, newLine: 5 },
      { oldLine: 7, newLine: 8 },
      { oldLine: 8, newLine: 9 },
      { oldLine: 9, newLine: 10 },
    ]);
    expect(hunk.removed).toEqual([{ line: 6, text: "three" }]);
    expect(hunk.added.map((l) => l.line)).toEqual([6, 7]);
  });

  it("handles zero-length hunks on either side", () => {
    const diff = ["--- a/z.ts", "+++ b/z.ts", "@@ -5,0 +6,2 @@", "+a", "+b", "@@ -30,2 +31,0 @@", "-c", "-d"].join("\n");
    const [file] = parseUnifiedDiff(diff);
    expect(file!.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([[5, 0, 6, 2], [30, 2, 31, 0]]);
    expect(changedRanges(file!)).toEqual({ after: [[6, 7]], before: [[30, 31]] });
    expect(file!.hunks.every((h) => h.context.length === 0)).toBe(true);
  });

  it("does not count the no-newline marker or split on \\r, U+2028 or U+2029", () => {
    const diff = [
      "--- a/w.ts",
      "+++ b/w.ts",
      "@@ -1,3 +1,3 @@",
      " a\r",
      " b still b still b",
      "-c",
      "\\ No newline at end of file",
      "+c2",
      "\\ No newline at end of file",
    ].join("\n");
    const hunk = parseUnifiedDiff(diff)[0]!.hunks[0]!;
    expect(hunk.context).toEqual([{ oldLine: 1, newLine: 1 }, { oldLine: 2, newLine: 2 }]);
    expect(hunk.removed).toEqual([{ line: 3, text: "c" }]);
    expect(hunk.added).toEqual([{ line: 3, text: "c2" }]);
  });

  it("returns binary entries only when asked", () => {
    const diff = ["diff --git a/logo.png b/logo.png", "index 1111111..2222222 100644", "Binary files a/logo.png and b/logo.png differ", ""].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([]);
    expect(parseUnifiedDiff(diff, { binary: true })).toEqual([{ path: "logo.png", oldPath: undefined, status: "modified", hunks: [], binary: true }]);
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

describe("anchor judgement", () => {
  // Two hunks at -U3: new lines 2-8 (added 5) and 20-26 (removed old 22, added new 23).
  const twoHunks = parseUnifiedDiff(
    [
      "--- a/src/q.ts",
      "+++ b/src/q.ts",
      "@@ -2,6 +2,7 @@",
      " l2", " l3", " l4", "+new5", " l5", " l6", " l7",
      "@@ -19,7 +20,7 @@",
      " l19", " l20", " l21", "-old22", "+new23", " l23", " l24", " l25",
    ].join("\n"),
  )[0]!;
  const at = (raw: string) => parseAnchor(raw);

  it("parses file:line and ranges, rejecting columns and reversed ranges", () => {
    expect(at("src/a.ts:12")).toEqual({ raw: "src/a.ts:12", path: "src/a.ts", start: 12, end: 12 });
    expect(at("./src/a.ts:3-5")).toMatchObject({ path: "src/a.ts", start: 3, end: 5 });
    expect(() => at("src/a.ts:12:4")).toThrow(/has a column/);
    expect(() => at("src/a.ts:9-3")).toThrow(/ends before it starts/);
    expect(() => at("src/a.ts:0")).toThrow(/start at 1/);
    expect(looksLikeAnchor("main...HEAD")).toBe(false);
    expect(looksLikeAnchor("-")).toBe(false);
    expect(looksLikeAnchor("src/a.ts:12-14")).toBe(true);
  });

  it("accepts added and context lines and gives the other side of a context line", () => {
    expect(judge(at("src/q.ts:5"), twoHunks, "new", 40)).toMatchObject({ ok: true, reason: "-", inDiff: true, inFile: true });
    expect(judge(at("src/q.ts:6"), twoHunks, "new", 40)).toMatchObject({ ok: true, otherLine: 5 });
    expect(judge(at("src/q.ts:22-24"), twoHunks, "new", 40)).toMatchObject({ ok: true });
  });

  it("names the closer hunk for a line between two hunks", () => {
    expect(judge(at("src/q.ts:10"), twoHunks, "new", 40)).toMatchObject({ ok: false, reason: "not in diff - nearest 2-8", nearest: "2-8" });
    expect(judge(at("src/q.ts:17"), twoHunks, "new", 40)).toMatchObject({ reason: "not in diff - nearest 20-26" });
  });

  it("rejects a range that leaves its hunk, a line past the end and a removed line on the new side", () => {
    expect(judge(at("src/q.ts:7-10"), twoHunks, "new", 40)).toMatchObject({ ok: false, reason: "crosses hunk boundary - hunk 2-8", inDiff: false });
    expect(judge(at("src/q.ts:45"), twoHunks, "new", 40)).toMatchObject({ ok: false, reason: "past end of file (40 lines)", inFile: false });
    const removed = parseUnifiedDiff(["--- a/r.ts", "+++ b/r.ts", "@@ -30,2 +29,0 @@", "-x", "-y"].join("\n"))[0]!;
    expect(judge(at("r.ts:30"), removed, "new", 50)).toMatchObject({ ok: false, reason: "removed line - use --side old" });
    expect(judge(at("r.ts:30-31"), removed, "old", 52)).toMatchObject({ ok: true });
  });

  it("checks the old side: removed and context lines pass, an added line points to --side new", () => {
    expect(judge(at("src/q.ts:22"), twoHunks, "old", 39)).toMatchObject({ ok: true });
    expect(judge(at("src/q.ts:5"), twoHunks, "old", 39)).toMatchObject({ ok: true, otherLine: 6 });
    const added = parseUnifiedDiff(["--- a/s.ts", "+++ b/s.ts", "@@ -5,0 +6,2 @@", "+a", "+b"].join("\n"))[0]!;
    expect(judge(at("s.ts:6"), added, "old", 10)).toMatchObject({ ok: false, reason: "added line - use --side new" });
    expect(judge(at("s.ts:6-7"), added, "new", 12)).toMatchObject({ ok: true });
  });

  it("handles added, deleted, binary and absent files", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/n.ts b/n.ts", "new file mode 100644", "--- /dev/null", "+++ b/n.ts", "@@ -0,0 +1,2 @@", "+a", "+b",
        "diff --git a/d.ts b/d.ts", "deleted file mode 100644", "--- a/d.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-a", "-b",
        "diff --git a/logo.png b/logo.png", "Binary files a/logo.png and b/logo.png differ",
      ].join("\n"),
      { binary: true },
    );
    const [added, deleted, binary] = files;
    expect(judge(at("n.ts:2"), added, "new", 2)).toMatchObject({ ok: true });
    expect(judge(at("n.ts:1"), added, "old", 0)).toMatchObject({ ok: false, reason: "file added - use --side new" });
    expect(judge(at("d.ts:1"), deleted, "new", 0)).toMatchObject({ ok: false, reason: "removed line - use --side old" });
    expect(judge(at("d.ts:5"), deleted, "new", 0)).toMatchObject({ ok: false, reason: "file deleted - use --side old" });
    expect(judge(at("d.ts:2"), deleted, "old", 2)).toMatchObject({ ok: true });
    expect(judge(at("logo.png:1"), binary, "new", undefined)).toMatchObject({ ok: false, reason: "binary" });
    expect(judge(at("x.ts:1"), undefined, "new", undefined)).toMatchObject({ ok: false, reason: "file not in diff" });
  });

  it("counts lines on \\n only", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("a\r\nb c d\n")).toBe(2);
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

describe("impact logic", () => {
  const classify = (before: string | null | undefined, after: string | null, diff: string, status: FileInput["status"] = "modified") => {
    const [file] = parseUnifiedDiff(diff);
    const ranges = changedRanges(file!);
    return classifyFile({ path: "src/a.ts", status, ...ranges, beforeText: before, afterText: after });
  };
  const header = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n";
  const BEFORE = [
    'import { x } from "./x";',
    "export function f(a: number): number {",
    "  return a + 1;",
    "}",
    "export interface Shape {",
    "  w: number;",
    "}",
    "export class Box {",
    "  size(): number {",
    "    return 1;",
    "  }",
    "}",
    "",
  ].join("\n");
  const edit = (from: string, to: string) => BEFORE.replace(from, to);
  const summary = (r: ReturnType<typeof classifyFile>) => r.changes.map((c) => `${c.key} ${c.change}`);

  it("classifies a body edit as body", () => {
    const r = classify(BEFORE, edit("a + 1", "a + 2"), `${header}@@ -3 +3 @@\n-  return a + 1;\n+  return a + 2;\n`);
    expect(summary(r)).toEqual(["f#function body"]);
    expect(r.fileLevel).toBeUndefined();
  });

  it("classifies a parameter change as signature; whitespace and comments are not one", () => {
    const sig = classify(BEFORE, edit("(a: number)", "(a: number, b = 0)"), `${header}@@ -2 +2 @@\n-export function f(a: number): number {\n+export function f(a: number, b = 0): number {\n`);
    expect(summary(sig)).toEqual(["f#function signature"]);
    const ws = classify(BEFORE, edit("(a: number)", "( a:  number /* id */ )"), `${header}@@ -2 +2 @@\n-export function f(a: number): number {\n+export function f( a:  number /* id */ ): number {\n`);
    expect(summary(ws)).toEqual(["f#function body"]);
  });

  it("lifts interface members to the interface as a type change", () => {
    const r = classify(BEFORE, edit("w: number", "w: string"), `${header}@@ -6 +6 @@\n-  w: number;\n+  w: string;\n`);
    expect(summary(r)).toEqual(["Shape#interface type"]);
  });

  it("maps a class member line to the member, not the class", () => {
    const r = classify(BEFORE, edit("return 1;", "return 2;"), `${header}@@ -10 +10 @@\n-    return 1;\n+    return 2;\n`);
    expect(summary(r)).toEqual(["Box.size#method body"]);
  });

  it("reports added and removed Declarations", () => {
    const added = classify(BEFORE, `${BEFORE}export const g = (): void => {};\n`, `${header}@@ -12,0 +13 @@\n+export const g = (): void => {};\n`);
    expect(summary(added)).toEqual(["g#function added"]);
    const removed = classify(BEFORE, edit("export function f(a: number): number {\n  return a + 1;\n}\n", ""), `${header}@@ -2,3 +1,0 @@\n-export function f(a: number): number {\n-  return a + 1;\n-}\n`);
    expect(summary(removed)).toEqual(["f#function removed"]);
    expect(removed.changes[0]!.before).toMatchObject({ exported: true, line: 2 });
  });

  it("puts lines outside any Declaration in one file-level entry", () => {
    const r = classify(BEFORE, edit('"./x"', '"./y"'), `${header}@@ -1 +1 @@\n-import { x } from "./x";\n+import { x } from "./y";\n`);
    expect(r.changes).toEqual([]);
    expect(r.fileLevel).toEqual({ after: [[1, 1]], before: [] });
  });

  it("is modified when the before version is unavailable", () => {
    const r = classify(undefined, edit("a + 1", "a + 2"), `${header}@@ -3 +3 @@\n-  return a + 1;\n+  return a + 2;\n`);
    expect(summary(r)).toEqual(["f#function modified"]);
  });

  it("innermost and liftTypeLevel pick the narrowest meaningful Declaration", () => {
    const decls = collectDeclarations(parseSource("src/a.ts", BEFORE), "src/a.ts");
    expect(innermost(decls, 10)?.qualifiedName).toBe("Box.size");
    expect(innermost(decls, 1)).toBeUndefined();
    expect(liftTypeLevel(decls, innermost(decls, 6)!).qualifiedName).toBe("Shape");
    const mapped = mapRanges(decls, [[1, 3]]);
    expect([...mapped.touched.keys()]).toEqual(["f#function"]);
    expect(mapped.outside).toEqual([1]);
  });

  it("signatures join overloads so adding one changes the Signature", () => {
    const one = "export function p(a: string): string;\nexport function p(a: any) { return a; }\n";
    const two = "export function p(a: string): string;\nexport function p(a: number): number;\nexport function p(a: any) { return a; }\n";
    const sig = (text: string) => {
      const sf = parseSource("src/a.ts", text);
      return signatures(collectDeclarations(sf, "src/a.ts")).get("p#function");
    };
    expect(sig(one)).not.toBe(sig(two));
    expect(sig(one)!.split("\n")).toHaveLength(2);
  });

  it("reverseApply rebuilds the before text from -U0 and context hunks; null on mismatch", () => {
    const after = edit("a + 1", "a + 2").replace('"./x"', '"./y"');
    const u0 = parseUnifiedDiff(`${header}@@ -1 +1 @@\n-import { x } from "./x";\n+import { x } from "./y";\n@@ -3 +3 @@\n-  return a + 1;\n+  return a + 2;\n`)[0]!;
    expect(reverseApply(after, u0.hunks)).toBe(BEFORE);
    const ctx = parseUnifiedDiff(`${header}@@ -2,3 +2,3 @@\n export function f(a: number): number {\n-  return a + 1;\n+  return a + 2;\n }\n`)[0]!;
    expect(reverseApply(edit("a + 1", "a + 2"), ctx.hunks)).toBe(BEFORE);
    const deletion = parseUnifiedDiff(`${header}@@ -12,0 +13 @@\n+// tail\n`)[0]!;
    expect(reverseApply(`${BEFORE}// tail\n`, deletion.hunks)).toBe(BEFORE);
    expect(reverseApply(BEFORE, u0.hunks)).toBeNull();
  });

  it("orders exported signature/removed first, then type, added, body, modified", () => {
    const row = (change: Parameters<typeof rankOf>[0], exported: boolean, refsOutside = 1) => ({ change, exported, refsOutside, file: "a.ts", line: 1 });
    const sorted = [row("body", true, 9), row("modified", true), row("added", false), row("type", true), row("removed", true), row("signature", false), row("signature", true)]
      .sort(compareChanges)
      .map((r) => `${r.change}${r.exported ? "" : "-local"}`);
    expect(sorted).toEqual(["removed", "signature", "type", "added-local", "signature-local", "body", "modified"]);
  });

  it("allocateBudget keeps each symbol's first rows and spends the whole budget", () => {
    expect(allocateBudget([100, 2, 100], 50)).toEqual([24, 2, 24]);
    expect(allocateBudget([3, 0, 1], 50)).toEqual([3, 0, 1]);
    expect(allocateBudget([5, 5, 5], 2)).toEqual([1, 1, 0]);
  });

  it("formats local_only, ranges and whole-word matches", () => {
    expect(localOnlyLine(["a body", "b added"])).toBe("2 (a body; b added)");
    expect(localOnlyLine(Array.from({ length: 12 }, (_, i) => `n${i} body`))).toMatch(/^12 \(n0 body; .*n9 body; \+2\)$/);
    expect(formatRanges([[1, 3], [7, 7]])).toBe("1-3 7");
    expect(wordMatches("save(); autosave; user.save\n$save save$", "save")).toEqual([
      { line: 1, col: 1 },
      { line: 1, col: 24 },
    ]);
  });
});

describe("Signatures", () => {
  const sigs = (text: string, file = "src/a.ts") =>
    Object.fromEntries(collectDeclarations(parseSource(file, text), file).map((d) => [d.qualifiedName, d.fullSignature]));

  it("a plain variable is keyword + name + type annotation; the initializer is the body", () => {
    expect(sigs("export const states = [\n  'a',\n  'b',\n];\nlet n: number = 1;\nvar s!: string;\n")).toEqual({
      states: "export const states",
      n: "let n: number",
      s: "var s!: string",
    });
  });

  it("a function-valued variable is name + parameters + return type", () => {
    expect(sigs("export const f = async (a: number): Promise<number> => a;\nconst g = function (b) { return b; };\n")).toEqual({
      f: "export const f = async (a: number): Promise<number> =>",
      g: "const g = function (b)",
    });
  });

  it("class fields and enum members drop their initializer", () => {
    const s = sigs("export class C {\n  private count: number = 0;\n  static label = 'x';\n  onClick = (e: Event): void => {};\n}\nexport enum E { A = 1, B }\n");
    expect(s).toMatchObject({ "C.count": "private count: number", "C.label": "static label", "C.onClick": "onClick = (e: Event): void =>", "E.A": "A", "E.B": "B" });
  });
});

describe("variable initializer edits", () => {
  const header = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n";
  const classify = (before: string, after: string, diff: string) => {
    const [file] = parseUnifiedDiff(`${header}${diff}`);
    return classifyFile({ path: "src/a.ts", status: "modified", ...changedRanges(file!), beforeText: before, afterText: after })
      .changes.map((c) => `${c.key} ${c.change}`);
  };
  const BEFORE = "export const childStates = [\n  'a',\n  'b',\n];\n";

  it("an initializer-only edit is body; a type annotation edit is signature", () => {
    expect(classify(BEFORE, BEFORE.replace("'b'", "'c'"), "@@ -3 +3 @@\n-  'b',\n+  'c',\n")).toEqual(["childStates#variable body"]);
    const typed = BEFORE.replace("childStates =", "childStates: string[] =");
    expect(classify(BEFORE, typed, "@@ -1 +1 @@\n-export const childStates = [\n+export const childStates: string[] = [\n")).toEqual(["childStates#variable signature"]);
  });
});

describe("nested declarations", () => {
  const decls = (text: string, file = "src/a.js") =>
    collectDeclarations(parseSource(file, text), file).map((d) => `${d.kind} ${d.qualifiedName}${d.exported ? " exported" : ""}${d.nameless ? " nameless" : ""}`);

  it("call-registered callbacks take the string name; the DI array form takes its last element", () => {
    const text = "angular.module('m').controller('MainCtrl', ['$scope', function ($scope) {}]).factory('api', function () { return { get: function () {} }; }).run(function () {});\n";
    expect(decls(text)).toEqual(["function MainCtrl exported nameless", "function api exported nameless", "method api.get exported", "function run exported nameless"]);
    const main = collectDeclarations(parseSource("src/a.js", text), "src/a.js")[0]!;
    expect(main).toMatchObject({ name: "MainCtrl", parentName: "controller", signature: "controller MainCtrl($scope)" });
    // The DI array is compared but not displayed.
    expect(main.fullSignature).toBe("controller MainCtrl($scope)\n['$scope']");
  });

  it("a registration by identifier links to the same-scope function, declared before or after (hoisted)", () => {
    const text = [
      "(function () {",
      "  angular.module('m').directive('fancyBox', fancyBox).factory('store', ['$http', makeStore]).config(routes);",
      "  fancyBox.$inject = ['$uibModal'];",
      "  function fancyBox($uibModal) { return { scope: { size: '@' }, link: function () {} }; }",
      "  function makeStore($http) { return { load: function () {} }; }",
      "  function routes($stateProvider) { $stateProvider.state('home', { url: '/' }); }",
      "  angular.module('m').filter('short', short);",
      "  var short = function () { return function (s) { return s; }; };",
      "})();",
      "",
    ].join("\n");
    expect(decls(text)).toEqual([
      "function fancyBox exported nameless",
      "function store exported nameless",
      "function config exported nameless",
      "function fancyBox",
      "property fancyBox.size exported",
      "function makeStore",
      "method store.load exported",
      "function routes",
      "state states.home exported nameless",
      "function short exported nameless",
      "function short",
    ]);
    const all = collectDeclarations(parseSource("src/a.js", text), "src/a.js");
    const reg = all.find((d) => d.nameless && d.name === "fancyBox")!;
    const fn = all.find((d) => !d.nameless && d.name === "fancyBox")!;
    expect(reg).toMatchObject({ line: 2, nameLine: 4, namePos: fn.namePos, signature: "directive fancyBox($uibModal)", fullSignature: "directive fancyBox($uibModal)\n['$uibModal']" });
    expect(registrationOf(fn, all)).toBe(reg);
    expect(registrationOf(all.find((d) => d.name === "makeStore")!, all)?.qualifiedName).toBe("store");
    expect(all.find((d) => d.name === "store" && d.nameless)?.fullSignature).toBe("factory store($http)\n['$http']");
  });

  it("self = this members and factory objects name nested functions by identifier, once each", () => {
    const text = [
      "angular.module('m').service('store', store).factory('api', api).controller('Ctrl', function () {",
      "  let vm = this;",
      "  vm.go = go;",
      "  function go() {}",
      "});",
      "function store($http) {",
      "  const self = this;",
      "  self.load = load;",
      "  self.drop = drop;",
      "  self.http = $http;",
      "  self.cache = {};",
      "  self.data = data;",
      "  return { load };",
      "  function load(id) {}",
      "  var drop = function () {};",
      "  var data = [];",
      "}",
      "function api() {",
      "  var service = { get: get, put };",
      "  service.del = del;",
      "  return service;",
      "  function get() {}",
      "  function put(x) {}",
      "  function del() {}",
      "}",
      "",
    ].join("\n");
    expect(decls(text)).toEqual([
      "function store exported nameless",
      "function api exported nameless",
      "function Ctrl exported nameless",
      "method Ctrl.go exported",
      "function store",
      "method store.load exported",
      "method store.drop exported",
      "function api",
      "method api.get exported",
      "method api.put exported",
      "method api.del exported",
    ]);
    const all = collectDeclarations(parseSource("src/a.js", text), "src/a.js");
    expect(all.find((d) => d.qualifiedName === "store.load")).toMatchObject({ line: 14, nameLine: 14, endLine: 14, aliasLine: 8, signature: "function load(id)" });
    expect(all.find((d) => d.qualifiedName === "store.drop")).toMatchObject({ line: 15, aliasLine: 9, signature: "var drop = function ()" });
    expect(all.find((d) => d.qualifiedName === "api.put")).toMatchObject({ line: 23, aliasLine: 19 });
  });

  it("object-literal holders, prototype and static assignments, this-members", () => {
    const text = [
      "function Store() { this.load = function () {}; }",
      "Store.prototype.save = function (x) {};",
      "Store.create = function () {};",
      "module.exports = { a() {}, b: function () {}, c: 1 };",
      "exports.d = () => 1;",
      "Meteor.methods({ m() {} });",
      "if (Meteor.isClient) { Template.home.helpers({ h() {} }); }",
      "",
    ].join("\n");
    expect(decls(text)).toEqual([
      "function Store",
      "method Store.load",
      "method Store.save",
      "method Store.create",
      "method exports.a exported",
      "method exports.b exported",
      "method exports.d exported",
      "method methods.m exported",
      "method Template.home.helpers.h exported",
    ]);
  });

  it("function-valued members of objects that leave a function, exports.x, this.x or export default; data members stay out", () => {
    const text = [
      "function createDeps(warn) { const n = 1; return { warn, check: async (a, b) => a, describe() {}, limit: 2 }; }",
      "const makeApi = () => ({ load: function () {} });",
      "exports.config = { onReady() {}, port: 80 };",
      "exports.build = function () { return { run() {} }; };",
      "function Panel() { this.handlers = { click: () => 1 }; }",
      "function helper() { if (x) { return { nested() {} }; } const local = { inner() {} }; }",
      "",
    ].join("\n");
    expect(decls(text)).toEqual([
      "function createDeps",
      "method createDeps.check",
      "method createDeps.describe",
      "function makeApi",
      "method makeApi.load",
      "method config.onReady exported",
      "method exports.build exported",
      "method build.run exported",
      "function Panel",
      "method Panel.handlers.click",
      "function helper",
    ]);
    expect(decls("export function useForm() { return { submit() {} }; }\nexport default { mounted() {}, name: 'x' };\n", "src/a.ts")).toEqual([
      "function useForm exported",
      "method useForm.submit exported",
      "method default.mounted exported",
    ]);
  });

  it("IIFE top-level functions are local Declarations; their inner functions are not", () => {
    const text = "(function () {\n  function helper() { function inner() {} }\n  var fmt = function () {};\n  var n = 1;\n})();\n!function () { function other() {} }();\n";
    expect(decls(text)).toEqual(["function helper", "function fmt", "function other"]);
  });

  it("router states: chained .state() forms, ngRoute .when(), a provider-taking function; otherwise() ignored", () => {
    const text = [
      "function routes($stateProvider, $urlRouterProvider) {",
      "  $urlRouterProvider.otherwise('/');",
      "  $stateProvider.state('a', { url: '/a', views: { main: { controller: function () {} } } }).state({ name: 'b', onEnter() {} });",
      "}",
      "angular.module('m').config(function ($routeProvider) {",
      "  $routeProvider.when('/c', { templateUrl: 'c.html', resolve: { d: ['svc', function (svc) {}] } });",
      "});",
      "",
    ].join("\n");
    expect(decls(text)).toEqual([
      "function routes",
      "state states.a exported nameless",
      "method states.a.views.main.controller exported",
      "state states.b exported nameless",
      "method states.b.onEnter exported",
      "function config exported nameless",
      "state routes./c exported nameless",
      "method routes./c.resolve.d exported",
    ]);
    const all = collectDeclarations(parseSource("src/a.js", text), "src/a.js");
    expect(all.find((d) => d.qualifiedName === "states.a")).toMatchObject({ kind: "state", name: "a", signature: "state a (url /a)" });
    // Plain-literal options are compared, not displayed.
    expect(all.find((d) => d.qualifiedName === "routes./c")?.fullSignature).toBe("route /c\ntemplateUrl: 'c.html'");
  });

  it("directive scope and component bindings are property members", () => {
    const text = "angular.module('m').directive('wapSelect', () => ({ scope: { a: '=' }, bindToController: { b: '@' } })).component('tag', { bindings: { c: '<' } });\n";
    expect(decls(text)).toEqual(["function wapSelect exported nameless", "property wapSelect.a exported", "property wapSelect.b exported", "variable tag exported nameless", "property tag.c exported"]);
  });

  it("changed lines map to the nested Declaration, not the enclosing IIFE variable", () => {
    const text = "var api = (function () {\n  function helper() {\n    return 1;\n  }\n  return { helper: helper };\n})();\n";
    const all = collectDeclarations(parseSource("src/a.js", text), "src/a.js");
    expect(innermost(all, 3)?.qualifiedName).toBe("helper");
    expect(innermost(all, 5)?.qualifiedName).toBe("api");
  });
});

describe("ambiguity lists", () => {
  const groups = (files: string[], extra = "") =>
    groupSymbols(files.flatMap((file) => collectDeclarations(parseSource(file, `export function dup() {}\n${extra}`), file).filter((d) => d.name === "dup")));

  it("caps rows at MATCH_ROWS with matches_total and truncated", () => {
    const g = groups(Array.from({ length: 25 }, (_, i) => `src/m${String(i).padStart(2, "0")}.ts`));
    const block = matchRows(g);
    expect((block["matches"] as unknown[]).length).toBe(MATCH_ROWS);
    expect(block).toMatchObject({ matches_total: 25, truncated: true });
    expect(matchRows(g.slice(0, 3))).not.toHaveProperty("truncated");
  });

  it("offers the top directories below the common prefix by count", () => {
    const files = [...Array.from({ length: 3 }, (_, i) => `pkg/a/x${i}.ts`), "pkg/b/y.ts", "pkg/c/z.ts"];
    const ctx = { root: "/repo", cwd: "/repo" } as unknown as Parameters<typeof narrowHints>[0];
    const hints = narrowHints(ctx, "refs", groups(files), { in: [], exported: false, fuzzy: false }, "dup", { kind: "name", name: "dup" });
    expect(hints.filter((h) => h.includes("--in"))).toEqual(["Run `ts-axi refs dup --in pkg/a` to keep 3 of 5", "Run `ts-axi refs dup --in pkg/b` to keep 1 of 5"]);
  });

  it("prints --in hints relative to the current directory", () => {
    const files = ["pkg/a/x0.ts", "pkg/a/x1.ts", "pkg/b/y.ts"];
    const ctx = { root: "/repo", cwd: "/repo/pkg/a" } as unknown as Parameters<typeof narrowHints>[0];
    const hints = narrowHints(ctx, "refs", groups(files), { in: [], exported: false, fuzzy: false }, "dup", { kind: "name", name: "dup" });
    expect(hints.filter((h) => h.includes("--in"))).toEqual(["Run `ts-axi refs dup --in .` to keep 2 of 3", "Run `ts-axi refs dup --in ../b` to keep 1 of 3"]);
  });
});

describe("classifyReferenceGroups", () => {
  const ref = (key: string, extra: Partial<RefDescriptor> = {}): RefDescriptor => ({ key, isDefinition: false, atDefinition: false, isSuper: false, ...extra });
  const group = (key: string, name: string, refs: RefDescriptor[], o: { member?: boolean; bases?: string[] } = {}): GroupDescriptor<RefDescriptor> => ({
    key,
    name,
    member: o.member ?? true,
    bases: o.bases ?? [],
    refs,
  });
  const keys = (refs: RefDescriptor[]) => refs.map((r) => r.key);

  // Shape of findReferences on an implementation: the interface group plus every implementation's group.
  const iface = group("i", "Parser.parse", [ref("i-decl", { atDefinition: true }), ref("registry")]);
  const date = group("d", "DateParser.parse", [ref("d-decl", { isDefinition: true, atDefinition: true }), ref("direct-call")], { bases: ["i"] });
  const name = group("n", "NameParser.parse", [ref("n-decl", { atDefinition: true }), ref("name-call")], { bases: ["i"] });

  it("an implementation: own group direct, interface uses via, siblings dropped", () => {
    const c = classifyReferenceGroups([iface, date, name], 1);
    expect(keys(c.direct)).toEqual(["direct-call"]);
    expect(keys(c.declarations)).toEqual(["d-decl"]);
    expect(c.via.map((v) => [v.ref.key, v.via, v.through])).toEqual([["registry", "Parser.parse", "base"]]);
    expect(keys(c.dropped).sort()).toEqual(["i-decl", "n-decl", "name-call"]);
    expect(c.implementations).toEqual([]);
    expect(c.bases).toEqual(["Parser.parse"]);
  });

  it("the interface member: implementations counted, their uses via, nothing dropped", () => {
    const c = classifyReferenceGroups([iface, date, name], 0);
    expect(keys(c.direct)).toEqual(["registry"]);
    expect(keys(c.declarations)).toEqual(["i-decl"]);
    expect(c.implementations.map((i) => [i.ref.key, i.name])).toEqual([["d-decl", "DateParser.parse"], ["n-decl", "NameParser.parse"]]);
    expect(c.via.map((v) => [v.ref.key, v.through])).toEqual([["direct-call", "implementation"], ["name-call", "implementation"]]);
    expect(c.dropped).toEqual([]);
  });

  it("an override drops super calls of the base; non-member groups (aliases) stay direct", () => {
    const base = group("b", "Base.parse", [ref("b-decl", { atDefinition: true }), ref("super-call", { isSuper: true }), ref("base-call")]);
    const lower = group("l", "Lower.parse", [ref("l-decl", { isDefinition: true, atDefinition: true })], { bases: ["b"] });
    const alias = group("a", "parseAlias", [ref("alias-use")], { member: false });
    const c = classifyReferenceGroups([base, lower, alias], 1);
    expect(c.via.map((v) => v.ref.key)).toEqual(["base-call"]);
    expect(keys(c.dropped).sort()).toEqual(["b-decl", "super-call"]);
    expect(keys(c.direct)).toEqual(["alias-use"]);
  });

  it("a mock mapped type's extra group defined at the target is direct; a same-named sibling stays dropped", () => {
    const svc = group("s", "ItemService.findItem", [ref("s-decl", { isDefinition: true, atDefinition: true }), ref("real-call")]);
    const mocked = group("s", "ItemService.findItem", [ref("s-decl", { atDefinition: true }), ref("mock-setup"), ref("mock-expect")]);
    const other = group("o", "OtherService.findItem", [ref("o-decl", { atDefinition: true }), ref("other-call")]);
    const c = classifyReferenceGroups([svc, mocked, other], 0);
    expect(keys(c.direct).sort()).toEqual(["mock-expect", "mock-setup", "real-call"]);
    expect(keys(c.declarations)).toEqual(["s-decl"]);
    expect(keys(c.dropped).sort()).toEqual(["o-decl", "other-call"]);
  });

  it("a plain function keeps every group direct and dedupes positions by the best bucket", () => {
    const fn = group("f", "parse", [ref("f-decl", { isDefinition: true }), ref("use")], { member: false });
    const alias = group("a", "parseList", [ref("use"), ref("alias-use")], { member: false });
    const c = classifyReferenceGroups([fn, alias], 0);
    expect(keys(c.direct)).toEqual(["use", "alias-use"]);
    expect(keys(c.declarations)).toEqual(["f-decl"]);
  });

  it("viaLine prints the count with distinct member names", () => {
    expect(viaLine(7, ["A.parse", "A.parse"])).toBe("7 (A.parse)");
    expect(viaLine(2, ["A.parse", "B.parse"])).toBe("2 (A.parse; B.parse)");
    expect(viaLine(0, [])).toBe("0");
  });
});

describe("template usages", () => {
  const all = collectDeclarations(
    parseSource("a.js", "angular.module('m').directive('wapSelect', function () { return { scope: { fallbackDisplayProperty: '=', items: '<' } }; }).controller('CartCtrl', function () {}).filter('money', function () {});\n"),
    "a.js",
  );
  const target = (name: string) => templateTarget(all.find((d) => d.qualifiedName === name)!, all)!;
  const lines = (text: string, name: string) => usagesIn(text, target(name)).map((u) => u.line);

  it("kebab-cases camelCase names", () => {
    expect(kebab("wapSelect")).toBe("wap-select");
    expect(kebab("fallbackDisplayProperty")).toBe("fallback-display-property");
    expect(kebab("HTMLView")).toBe("html-view");
  });

  it("matches elements and attributes once per line, not lookalikes", () => {
    const html = ['<wap-select items="x"></wap-select>', '<div data-wap-select="y">', "<wap-selector>", "</wap-select>", "<p>wap-select-ish</p>", "<div x-wap-select>"].join("\n");
    expect(lines(html, "wapSelect")).toEqual([1, 2, 6]);
  });

  it("a binding counts only on a tag carrying its directive", () => {
    const html = ['<wap-select\n  fallback-display-property="a">', '<other fallback-display-property="b">', '<div wap-select items="c">'].join("\n");
    expect(lines(html, "wapSelect.fallbackDisplayProperty")).toEqual([2]);
    expect(lines(html, "wapSelect.items")).toEqual([4]);
  });

  it("a tag spans lines and ends at a '>' outside quotes; broken markup never throws", () => {
    const html = ["<wap-select", '  data-ng-if="a > 1"', "  data-fallback-display-property='b'", "></wap-select>", '<other title="items x" fallback-display-property="c">'].join("\n");
    expect(lines(html, "wapSelect.fallbackDisplayProperty")).toEqual([3]);
    expect(lines('<wap-select title="x fallback-display-property="', "wapSelect.fallbackDisplayProperty")).toEqual([]);
    expect(lines('<wap-select data-x="unclosed\n<wap-select items="z">', "wapSelect.items")).toEqual([]);
    expect(lines(`${"\n".repeat(50)}<wap-select${"\n".repeat(45)} items="far">`, "wapSelect.items")).toEqual([]);
  });

  it("controllers in ng-controller, filters after a single pipe", () => {
    expect(lines('<div ng-controller="CartCtrl as c">\n<div data-ng-controller=\'CartCtrlX\'>', "CartCtrl")).toEqual([1]);
    expect(lines("{{ a | money }}\n{{ a || money }}\n{{ a |money:2 }}", "money")).toEqual([1, 3]);
  });
});

describe("textual scope (isPlainLocal)", () => {
  /** Whether the textual count of `name` stays in its declaring file. */
  const local = (file: string, text: string, name: string) => {
    const sf = parseSource(file, text);
    const index = { abs: (rel: string) => rel, sourceFile: () => sf } as unknown as SyntacticIndex;
    return isPlainLocal(index, collectDeclarations(sf, file).find((d) => d.name === name));
  };

  it("function-scoped bindings and private ES module bindings are local", () => {
    expect(local("a.js", "(function () { function helper() {} })();", "helper")).toBe(true);
    expect(local("a.ts", "import x from 'x';\nconst hidden = 1;\nexport const shown = hidden;", "hidden")).toBe(true);
  });

  it("a CommonJS top-level binding is local unless an exports assignment hands it out", () => {
    const text = "const TAX = 1;\nfunction calc() { return TAX; }\nfunction inner() {}\nmodule.exports = { calc, run() { return TAX; } };\nexports.extra = inner;";
    expect(local("a.js", text, "TAX")).toBe(true);
    expect(local("a.js", text, "calc")).toBe(false);
    expect(local("a.js", text, "inner")).toBe(false);
    expect(local("a.js", "const fs = require('fs');\nfunction privateOne() {}", "privateOne")).toBe(true);
  });

  it("a script's top-level binding is a global; members are never local", () => {
    expect(local("a.js", "function shared() {}", "shared")).toBe(false);
    expect(local("a.js", "function make() { return { item: () => 1 }; }", "item")).toBe(false);
  });
});
