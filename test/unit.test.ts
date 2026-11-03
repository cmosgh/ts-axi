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
import { parseSource } from "../src/project.js";
import { collectDeclarations } from "../src/symbols.js";

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
      return signatures(sf, collectDeclarations(sf, "src/a.ts")).get("p#function");
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
