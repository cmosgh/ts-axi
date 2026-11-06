import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { committed, COMMONJS_FIXTURE, ESM_FIXTURE, FIXTURE, fixtureCopy, LEGACY_FIXTURE, MOCKS_FIXTURE, runner, WORKSPACE_FIXTURE, type RunResult } from "./helpers.js";

type Payload = Record<string, unknown>;

let run: (...argv: string[]) => Promise<RunResult>;

beforeAll(() => {
  run = runner(fixtureCopy());
});

/** Plain TOON output (no fences) must decode. */
function toon(stdout: string): Payload {
  return decode(stdout, { strict: true }) as Payload;
}

/** The fenced block between the two `---` lines. */
function fence(stdout: string): string {
  const parts = stdout.split("\n---\n");
  expect(parts.length).toBeGreaterThanOrEqual(3);
  return parts[1]!;
}

describe("outline", () => {
  it("lists top-level Declarations in source order with class members nested", async () => {
    const { stdout, exitCode } = await run("outline", "src/models/user.ts");
    expect(exitCode).toBe(0);
    const data = toon(stdout);
    expect(data["file"]).toBe("src/models/user.ts");
    const decls = data["decls"] as Payload[];
    expect(decls.map((d) => d["name"])).toEqual([
      "User",
      "User.table",
      "User.secret",
      "User.createdAt",
      "User.constructor",
      "User.save",
      "User.create",
      "isAdmin",
    ]);
    expect(decls.find((d) => d["name"] === "User.save")).toEqual({ line: 13, kind: "method", name: "User.save", signature: "save(): boolean" });
    const withExported = toon((await run("outline", "src/models/user.ts", "--fields", "exported")).stdout)["decls"] as Payload[];
    expect(withExported.find((d) => d["name"] === "User.secret")).toMatchObject({ kind: "property", exported: false });
    expect(withExported.find((d) => d["name"] === "User.save")).toMatchObject({ exported: true });
    expect(stdout).toContain("ts-axi def src/models/user.ts:5");
  });

  it("--exported over a glob adds an at column and drops private members", async () => {
    const data = toon((await run("outline", "src/models/*.ts", "--exported", "--fields", "exported")).stdout);
    const decls = data["decls"] as Payload[];
    expect(data["files"]).toBe(3);
    expect(decls.every((d) => d["exported"] === true)).toBe(true);
    expect(decls.some((d) => d["name"] === "User.secret")).toBe(false);
    expect(decls.find((d) => d["name"] === "Role")).toMatchObject({ at: expect.stringMatching(/^src\/models\/types\.ts:\d+$/), kind: "enum" });
    expect(decls.find((d) => d["name"] === "UserId")).toMatchObject({ kind: "type", signature: "export type UserId = string" });
  });

  it("rejects a missing file with a usage error", async () => {
    const { stdout, exitCode } = await run("outline", "src/nope.ts");
    expect(exitCode).toBe(2);
    expect(toon(stdout)).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("def", () => {
  it("prints one match with a fenced body carrying file line numbers", async () => {
    const { stdout, exitCode } = await run("def", "User.save");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("file: src/models/user.ts\nline: 13\nkind: method\nexported: true");
    expect(fence(stdout)).toBe(
      ["  13 |   save(): boolean {", "  14 |     this.secret = this.id;", "  15 |     return this.secret.length > 0;", "  16 |   }"].join("\n"),
    );
    expect(stdout).toContain("ts-axi refs src/models/user.ts:13");
    expect(stdout).toContain("ts-axi callers src/models/user.ts:13");
  });

  it("treats overloads as one Symbol", async () => {
    const { stdout } = await run("def", "runSync");
    expect(stdout).toContain("overloads: 2");
    expect(fence(stdout).split("\n")).toHaveLength(6);
  });

  it("lists several matches with concrete narrowing hints", async () => {
    // --kind function: the parsers' `parse` methods share the name.
    const { stdout, exitCode } = await run("def", "parse", "--kind", "function");
    expect(exitCode).toBe(0);
    const data = toon(stdout);
    expect(data["matches"]).toEqual([
      { at: "src/format/parse.ts:1", kind: "function", signature: "export function parse(input: string): string[]" },
      { at: "src/services/parse.ts:3", kind: "function", signature: "export function parse(raw: string): number[]" },
    ]);
    expect(stdout).toContain("ts-axi def src/format/parse.ts:1");
    expect(stdout).toContain("ts-axi def parse --kind function --in src/format");
  });

  it("--in narrows an ambiguous name to one Declaration", async () => {
    const { stdout } = await run("def", "parse", "--in", "src/services");
    expect(stdout).toContain("file: src/services/parse.ts");
  });

  it("zero matches is definitive with did_you_mean", async () => {
    const { stdout, exitCode } = await run("def", "runSnc");
    expect(exitCode).toBe(0);
    const data = toon(stdout);
    expect(data["matches"]).toBe(0);
    expect(data["did_you_mean"]).toContain("runSync");
  });

  it("--fuzzy matches substrings case-insensitively", async () => {
    const data = toon((await run("def", "SYNC", "--fuzzy")).stdout);
    const files = (data["matches"] as Payload[]).map((m) => m["signature"]);
    expect(files).toEqual(expect.arrayContaining([expect.stringContaining("runSync"), expect.stringContaining("syncAll")]));
  });

  it("--exported keeps exported Declarations only", async () => {
    expect(toon((await run("def", "saveOne", "--exported")).stdout)["matches"]).toBe(0);
    expect((await run("def", "saveOne")).stdout).toContain("exported: false");
  });

  it("resolves a position on a Declaration line without a type check", async () => {
    const { stdout } = await run("def", "src/models/user.ts:23");
    expect(stdout).toContain("signature: \"export function isAdmin(user: User): boolean\"");
    expect(stdout).not.toContain("elapsed_ms");
  });

  it("a constructor line names the constructor, not its parameter properties", async () => {
    expect((await run("def", "src/models/user.ts:10")).stdout).toContain("line: 10\nkind: method\nexported: true\nsignature: \"constructor(");
  });

  it("follows a reference position to its Declaration", async () => {
    const { stdout } = await run("def", "src/services/sync.ts:13:15");
    expect(stdout).toContain("file: src/models/user.ts\nline: 13");
    expect(stdout).toMatch(/elapsed_ms: \d+/);
  });

  it("lists the identifiers of a line that declares nothing", async () => {
    const data = toon((await run("def", "src/services/sync.ts:13")).stdout);
    expect(data["identifiers"]).toEqual([
      { name: "user", line: 13, col: 10 },
      { name: "save", line: 13, col: 15 },
    ]);
  });

  it("truncates long bodies at 60 lines with an exact total; --full lifts it", async () => {
    const dir = fixtureCopy();
    const body = Array.from({ length: 70 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    writeFileSync(join(dir, "src", "long.ts"), `export function longOne(): void {\n${body}\n}\n`);
    const r = runner(dir);
    const cut = fence((await r("def", "longOne")).stdout).split("\n");
    expect(cut).toHaveLength(61);
    expect(cut.at(-1)).toBe("... (truncated, 72 lines total)");
    expect(fence((await r("def", "longOne", "--full")).stdout).split("\n")).toHaveLength(72);
  });
});

describe("refs", () => {
  it("refuses an ambiguous name and lists the candidates", async () => {
    const { stdout, exitCode } = await run("refs", "parse", "--kind", "function");
    expect(exitCode).toBe(0);
    const data = toon(stdout);
    expect(data["matches"]).toHaveLength(2);
    expect(data).not.toHaveProperty("refs_total");
    expect(stdout).toContain("ts-axi refs src/services/parse.ts:3");
  });

  it("finds User.save through the barrel and from JS, not through any", async () => {
    const { stdout, exitCode } = await run("refs", "User.save");
    expect(exitCode).toBe(0);
    const data = toon(stdout);
    expect(data).toMatchObject({ symbol: "User.save", kind: "method", declared_at: "src/models/user.ts:13", refs_total: 2, files: 2, tests: 0 });
    expect(data["refs"]).toEqual([
      { file: "src/legacy/util.js", line: 5, context: "return user.save();" },
      { file: "src/services/sync.ts", line: 13, context: "return user.save();" },
    ]);
    expect(stdout).not.toContain("src/dynamic.ts");
    expect(data["elapsed_ms"]).toEqual(expect.any(Number));
    expect(data).not.toHaveProperty("diagnostics");
  });

  it("resolves a position target and counts Test files", async () => {
    const data = toon((await run("refs", "src/services/sync.ts:4")).stdout);
    expect(data).toMatchObject({ symbol: "runSync", kind: "function", tests: 1 });
    expect((data["refs"] as Payload[]).map((r) => r["file"])).toContain("src/services/sync.test.ts");
  });

  it("--test-glob adds a Test file pattern at run time", async () => {
    const data = toon((await run("refs", "runSync", "--test-glob", "src/dynamic.ts")).stdout);
    expect(data["tests"]).toBe(2);
  });

  it("--limit cuts rows and keeps the exact total", async () => {
    const data = toon((await run("refs", "runSync", "--limit", "1")).stdout);
    expect(data["refs"]).toHaveLength(1);
    expect(data).toMatchObject({ refs_total: 5, truncated: true });
    expect(data["help"]).toEqual(expect.arrayContaining([expect.stringContaining("--limit 5")]));
  });

  it("--kind calls is the same as callers", async () => {
    const data = toon((await run("refs", "User.save", "--kind", "calls")).stdout);
    expect((data["refs"] as Payload[])[0]).toHaveProperty("caller");
  });

  it("--json decodes to the same payload", async () => {
    const { stdout } = await run("refs", "User.save", "--json");
    const data = JSON.parse(stdout) as Payload;
    expect(data).toMatchObject({ symbol: "User.save", refs_total: 2 });
    expect(data["help"]).toEqual(expect.any(Array));
  });

  it("reports type errors as a count only", async () => {
    const dir = fixtureCopy();
    writeFileSync(join(dir, "src", "broken.ts"), `import { isAdmin } from "./models";\nexport const bad: number = isAdmin("x");\n`);
    const data = toon((await runner(dir)("refs", "isAdmin")).stdout);
    expect(data["diagnostics"]).toBeGreaterThan(0);
    expect(data["refs_total"]).toBe(2);
  });
});

describe("callers", () => {
  it("names the enclosing function per call site and aggregates --depth 2", async () => {
    const { stdout, exitCode } = await run("callers", "User.save", "--depth", "2");
    expect(exitCode).toBe(0);
    const data = toon(stdout);
    expect(data["refs"]).toEqual([
      { file: "src/legacy/util.js", line: 5, caller: "legacySave", context: "return user.save();" },
      { file: "src/services/sync.ts", line: 13, caller: "saveOne", context: "return user.save();" },
    ]);
    expect(data["callers_depth2"]).toEqual(
      expect.arrayContaining([
        { caller: "runSync", file: "src/services/sync.ts", count: 1 },
        { caller: "(top-level)", file: "src/legacy/util.js", count: 1 },
      ]),
    );
  });

  it("marks module-level calls as (top-level)", async () => {
    const data = toon((await run("callers", "legacySave")).stdout);
    expect(data["refs"]).toEqual([{ file: "src/legacy/util.js", line: 8, caller: "(top-level)", context: 'legacySave("boot");' }]);
  });

  it("rejects --depth outside 1..3", async () => {
    expect((await run("callers", "runSync", "--depth", "4")).exitCode).toBe(2);
  });
});

describe("interface and base members", () => {
  it("callers DateParser.parse counts the direct call only; the interface call is via_interface", async () => {
    const { stdout } = await run("callers", "DateParser.parse");
    const data = toon(stdout);
    expect(data).toMatchObject({ symbol: "DateParser.parse", refs_total: 1, files: 1, via_interface: "1 (FieldParser.parse)" });
    expect(data["refs"]).toEqual([{ file: "src/services/dates.ts", line: 4, caller: "dayOf", context: "return new DateParser().parse(x);" }]);
    expect(stdout).not.toContain("name-parser.ts");
    expect(stdout).not.toContain("code-parser.ts");
    expect(stdout).toContain("ts-axi callers src/parsers/date-parser.ts:4 --via");
  });

  it("refs DateParser.parse drops sibling implementations and the interface Declaration", async () => {
    const { stdout } = await run("refs", "DateParser.parse");
    expect(toon(stdout)).toMatchObject({ refs_total: 1, via_interface: "1 (FieldParser.parse)" });
    expect(stdout).not.toMatch(/name-parser|code-parser|field-parser/);
  });

  it("--via adds the registry call with a via column", async () => {
    const data = toon((await run("callers", "DateParser.parse", "--via")).stdout);
    expect(data["refs_total"]).toBe(1);
    expect(data["refs"]).toEqual([
      { file: "src/parsers/registry.ts", line: 5, caller: "parseField", via: "FieldParser.parse", context: "return parser.parse(raw);" },
      { file: "src/services/dates.ts", line: 4, caller: "dayOf", via: "-", context: "return new DateParser().parse(x);" },
    ]);
  });

  it("refs FieldParser.parse counts implementations, rows only with --implementations", async () => {
    const data = toon((await run("refs", "FieldParser.parse")).stdout);
    expect(data).toMatchObject({ refs_total: 1, implementations: 3, via_implementations: "1 (DateParser.parse)" });
    expect(data["refs"]).toEqual([{ file: "src/parsers/registry.ts", line: 5, context: "return parser.parse(raw);" }]);
    const listed = toon((await run("refs", "FieldParser.parse", "--implementations")).stdout);
    expect(listed["implementations"]).toEqual([
      { file: "src/parsers/code-parser.ts", line: 4, symbol: "CodeParser.parse" },
      { file: "src/parsers/date-parser.ts", line: 4, symbol: "DateParser.parse" },
      { file: "src/parsers/name-parser.ts", line: 4, symbol: "NameParser.parse" },
    ]);
  });

  it("an override reaches the base call through via; super.parse stays with the base", async () => {
    const lower = toon((await run("refs", "LowerParser.parse", "--via")).stdout);
    expect(lower).toMatchObject({ refs_total: 0, via_interface: "1 (BaseParser.parse)" });
    expect(lower["refs"]).toEqual([{ file: "src/parsers/registry.ts", line: 9, via: "BaseParser.parse", context: "return parser.parse(raw);" }]);
    const base = toon((await run("refs", "BaseParser.parse")).stdout);
    expect(base).toMatchObject({ refs_total: 2, implementations: 1 });
    expect((base["refs"] as Payload[]).map((r) => `${r["file"]}:${r["line"]}`)).toEqual(["src/parsers/base-parser.ts:9", "src/parsers/registry.ts:9"]);
  });

  it("matches: 0 under -P names the file declared outside that Project and its tsconfig", async () => {
    const dir = fixtureCopy();
    mkdirSync(join(dir, "packages", "other"), { recursive: true });
    writeFileSync(join(dir, "packages", "other", "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ["*.ts"] }));
    writeFileSync(join(dir, "packages", "other", "tool.ts"), "export const tool = 1;\n");
    // A deeper copy (a stale checkout) sorts after the canonical file.
    mkdirSync(join(dir, "a", "copy", "src", "models"), { recursive: true });
    writeFileSync(join(dir, "a", "copy", "src", "models", "user.ts"), "export class User {\n  save(): void {}\n}\n");
    const { stdout } = await runner(dir)("refs", "User.save", "-P", "packages/other/tsconfig.json");
    const data = toon(stdout);
    expect(data).toMatchObject({
      matches: 0,
      found_outside_project: [{ file: "src/models/user.ts", line: 13 }, { file: "a/copy/src/models/user.ts", line: 2 }],
      hint: "symbol is declared outside the selected project - run with -P tsconfig.json or without -P",
    });
    expect(stdout).not.toContain("--fuzzy");
    expect(stdout).toContain("ts-axi refs User.save -P tsconfig.json");
  });
});

describe("cli", () => {
  it("rejects unknown flags with the valid set and a rename hint", async () => {
    const { stdout, exitCode } = await run("refs", "User", "--type", "class");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("--type is not supported here; use --kind instead");
    expect(stdout).toContain("valid flags for `ts-axi refs`");
  });

  it("warns on an implicit project", async () => {
    const r = runner(fixtureCopy({ tsconfig: false }));
    const { stdout } = await r("refs", "User.save");
    const data = toon(stdout);
    expect(data["warning"]).toBe("no tsconfig.json found - implicit project");
    expect(data["refs_total"]).toBe(2);
    expect(toon((await r("def", "parse")).stdout)["warning"]).toBe("no tsconfig.json found - implicit project");
  });

  it("-P pointing nowhere is a usage error", async () => {
    expect((await run("refs", "User.save", "-P", "nope.json")).exitCode).toBe(2);
  });

  it.each(["def", "refs", "callers", "outline", "impact", "anchor", "config"])("%s --help and -h print usage", async (command) => {
    for (const flag of ["--help", "-h"]) {
      const { stdout, exitCode } = await run(command, flag);
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(new RegExp(`^usage: ts-axi ${command}`));
    }
  });

  it("top-level --help lists the commands", async () => {
    expect((await run("--help")).stdout).toContain("def, refs, callers, outline, impact, anchor");
  });

});

describe("impact", () => {
  type Rows = Payload[];
  const git = (dir: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });

  /** A fixture copy on branch main with one commit, plus file editing helpers. */
  function repo(fixture?: string) {
    const dir = fixtureCopy(fixture ? { fixture } : {});
    git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    const path = (rel: string) => join(dir, rel);
    return {
      dir,
      run: runner(dir),
      edit(rel: string, from: string, to: string) {
        const text = readFileSync(path(rel), "utf8");
        expect(text).toContain(from);
        writeFileSync(path(rel), text.replace(from, to));
      },
      write: (rel: string, text: string) => writeFileSync(path(rel), text),
      git: (...args: string[]) => git(dir, ...args),
    };
  }

  // These tests check every column, so they ask for all of them.
  async function impact(r: ReturnType<typeof repo>, ...argv: string[]): Promise<Payload> {
    const { stdout, exitCode } = await r.run("impact", ...argv, ...(argv.includes("--fields") ? [] : ["--fields", "all"]));
    expect(exitCode).toBe(0);
    return toon(stdout);
  }
  const changed = (data: Payload) => data["changed"] as Rows;
  const refsOf = (data: Payload, symbol: string) =>
    (data["refs"] as Rows).filter((r) => r["symbol"] === symbol).map((r) => `${r["file"]}:${r["line"]}`);

  it("classifies a body edit and lists References outside the change set", async () => {
    const r = repo();
    r.edit("src/models/user.ts", "this.secret = this.id;", "this.secret = `${this.id}`;");
    const data = await impact(r);
    expect(data).toMatchObject({ base: "HEAD", head: "working tree", changes: 1 });
    expect(changed(data)).toEqual([
      { symbol: "User.save", kind: "method", change: "body", exported: true, at: "src/models/user.ts:13", refs_total: 2, refs_outside: 2, via: 0, files: 2, tests: 0 },
    ]);
    expect(refsOf(data, "User.save")).toEqual(["src/legacy/util.js:5", "src/services/sync.ts:13"]);
    expect(data["elapsed_ms"]).toEqual(expect.any(Number));
    expect(data["help"]).toEqual(expect.arrayContaining([expect.stringContaining("ts-axi refs src/models/user.ts:13")]));
  });

  it("defaults changed rows to four columns and adds --fields columns in their documented place", async () => {
    const r = repo();
    r.edit("src/models/user.ts", "this.secret = this.id;", "this.secret = `${this.id}`;");
    const plain = toon((await r.run("impact")).stdout);
    expect(changed(plain)).toEqual([{ symbol: "User.save", change: "body", at: "src/models/user.ts:13", refs_outside: 2 }]);
    expect(plain["help"]).toEqual(expect.arrayContaining(["Run `ts-axi impact --fields files,tests` for how many files and Test files reference each Symbol"]));
    const some = toon((await r.run("impact", "--fields", "Tests,kind")).stdout);
    expect(Object.keys(changed(some)[0]!)).toEqual(["symbol", "kind", "change", "at", "refs_outside", "tests"]);
    expect(some["help"]).not.toEqual(expect.arrayContaining([expect.stringContaining("--fields files,tests")]));
    // --fields all is the downstream contract: the pre-0.1.10 row, column for column.
    const all = toon((await r.run("impact", "--fields", "all")).stdout);
    expect(Object.keys(changed(all)[0]!)).toEqual(["symbol", "kind", "change", "exported", "at", "refs_total", "refs_outside", "via", "files", "tests"]);
    // Hints replay every given flag, --fields normalised.
    const flagged = toon((await r.run("impact", "--test-glob", "src/services/**", "--via", "--fields", "Tests, kind")).stdout);
    expect(flagged["help"]).toEqual(expect.arrayContaining([expect.stringContaining("ts-axi impact --via --test-glob 'src/services/**' --fields kind,tests --depth 2")]));
    const bad = await r.run("impact", "--fields", "owner");
    expect(bad.exitCode).toBe(2);
    expect(bad.stdout).toContain("available --fields: kind, exported, refs_total, via, files, tests (or all)");
  });

  it("names a missing revision and how to pick one", async () => {
    const { stdout, exitCode } = await repo().run("impact", "no-such-rev...HEAD");
    expect(exitCode).toBe(1);
    expect(toon(stdout)).toMatchObject({ code: "GIT_ERROR" });
    expect(stdout).toContain("git log --oneline -5");
  });

  it("puts the any access and the string key in src/dynamic.ts in blind_spots", async () => {
    const r = repo();
    r.edit("src/models/user.ts", "this.secret = this.id;", "this.secret = String(this.id);");
    const data = await impact(r);
    expect(data["blind_spots"]).toEqual([
      { symbol: "User.save", file: "src/dynamic.ts", line: 4, reason: "property access on any" },
      { symbol: "User.save", file: "src/dynamic.ts", line: 5, reason: "string key 'save' on a type without that member" },
    ]);
    expect(data["help"]).toEqual(expect.arrayContaining([expect.stringContaining("ts-axi impact --fields all --grep")]));
  });

  it("classifies a parameter change as signature and flags tests: 0", async () => {
    const r = repo();
    r.edit("src/services/parse.ts", "parse(raw: string)", "parse(raw: string, radix = 10)");
    const data = await impact(r);
    expect(changed(data)[0]).toMatchObject({ symbol: "parse", change: "signature", exported: true, refs_outside: 2, files: 1, tests: 0 });
    expect(refsOf(data, "parse")).toEqual(["src/services/sync.ts:2", "src/services/sync.ts:7"]);
    expect(data["blind_spots"]).toBe(0);
  });

  it("reports a deleted exported function as removed with its now-broken uses", async () => {
    const r = repo();
    r.edit("src/services/sync.ts", "export function syncAll(batches: string[][]): number {\n  let total = 0;\n  for (const batch of batches) total += runSync(batch);\n  return total;\n}\n", "");
    const data = await impact(r);
    expect(changed(data)[0]).toMatchObject({ symbol: "syncAll", change: "removed", exported: true, at: "src/services/sync.ts:16", refs_outside: 2 });
    expect(refsOf(data, "syncAll")).toEqual(["src/dynamic.ts:1", "src/dynamic.ts:11"]);
    expect(data["diagnostics"]).toBeGreaterThan(0);
  });

  it("reports added functions (tracked and untracked files) in local_only", async () => {
    const r = repo();
    r.edit("src/format/parse.ts", "\n}\n", "\n}\n\nexport function join(parts: string[]): string {\n  return parts.join(\",\");\n}\n");
    r.write("src/fresh.ts", "export function brandNew(): number {\n  return 1;\n}\n");
    const data = await impact(r);
    expect(data["changes"]).toBe(2);
    expect(data).not.toHaveProperty("changed");
    expect(data["local_only"]).toBe("2 (join added; brandNew added)");
  });

  it("classifies an interface edit as type, ordered after exported signature changes", async () => {
    const r = repo();
    r.edit("src/models/types.ts", "createdAt: number;", "createdAt: Date;");
    r.edit("src/services/parse.ts", "parse(raw: string)", "parse(raw: string, radix = 10)");
    const data = await impact(r);
    expect(changed(data).map((c) => `${c["symbol"]} ${c["change"]}`)).toEqual(["parse signature", "Entity type"]);
    expect(refsOf(data, "Entity")).toEqual(["src/models/user.ts:1", "src/models/user.ts:5"]);
  });

  it("an import-only edit is one file-level change with no References", async () => {
    const r = repo();
    r.edit("src/services/sync.ts", 'import { User } from "../models";', 'import { User } from "../models/index";');
    const data = await impact(r);
    expect(data).toMatchObject({ changes: 1, file_level: [{ file: "src/services/sync.ts", lines: "1" }] });
    expect(data).not.toHaveProperty("changed");
  });

  it("collapses Changes whose References are all inside the change set into local_only", async () => {
    const r = repo();
    r.edit("src/legacy/util.js", "return user.save();", "return user.save() && true;");
    r.edit("src/legacy/util.js", 'legacySave("boot");', 'legacySave("boot-2");');
    const data = await impact(r);
    expect(data).toMatchObject({ changes: 2, local_only: "1 (legacySave body)", file_level: [{ file: "src/legacy/util.js", lines: "8" }] });
  });

  it("reads a unified diff from stdin (impact -), with and without a repo", async () => {
    const r = repo();
    r.edit("src/services/parse.ts", "parse(raw: string)", "parse(raw: string, radix = 10)");
    const diff = r.git("diff", "-U0");
    const viaStdin = async (cwd: string): Promise<Payload> => {
      let stdout = "";
      await main({ argv: ["impact", "-"], cwd, stdin: diff, stdout: { write: (c: string) => (stdout += c) } });
      return toon(stdout);
    };
    const inRepo = await viaStdin(r.dir);
    expect(inRepo).toMatchObject({ base: "stdin diff", changes: 1 });
    expect(changed(inRepo)[0]).toMatchObject({ symbol: "parse", change: "signature", refs_outside: 2 });

    const bare = realpathSync(mkdtempSync(join(tmpdir(), "ts-axi-nogit-")));
    cpSync(r.dir, bare, { recursive: true, filter: (src) => !src.includes(".git") });
    const noRepo = await viaStdin(bare);
    expect(changed(noRepo)[0]).toMatchObject({ symbol: "parse", change: "signature" });
    rmSync(bare, { recursive: true, force: true });
  });

  it("--size counts files, zero-context hunks, lines and risky changes from the same diff", async () => {
    const r = repo();
    r.edit("src/services/parse.ts", "parse(raw: string)", "parse(raw: string, radix = 10)");
    r.write("src/extra.ts", "export const extra = 1;\nexport const more = 2;\n");
    const patch = r.git("diff", "-U0", "--no-color", "--no-ext-diff", "-M", "HEAD", "--");
    const data = await impact(r, "--size");
    expect(data["size"]).toEqual({ files: 2, hunks: 2, lines_added: 3, lines_removed: 1, patch_chars: patch.length, exported_signature_changes: 1, removed_symbols: 0 });
    expect(toon((await r.run("impact")).stdout)).not.toHaveProperty("size");
    const ranged = repo();
    ranged.git("checkout", "-q", "-b", "feature");
    ranged.edit("src/services/parse.ts", "parse(raw: string)", "parse(raw: string, radix = 10)");
    ranged.git("commit", "-q", "-am", "change");
    const diff = ranged.git("diff", "-U3", "main...feature");
    let stdout = "";
    await main({ argv: ["impact", "-", "--size"], cwd: ranged.dir, stdin: diff, stdout: { write: (c: string) => (stdout += c) } });
    expect(toon(stdout)["size"]).toMatchObject({ files: 1, hunks: 1, lines_added: 1, lines_removed: 1, patch_chars: diff.length });
  });

  it("analyses a branch range main...<branch> and names its head", async () => {
    const r = repo();
    r.git("checkout", "-q", "-b", "feature");
    r.edit("src/services/parse.ts", "parse(raw: string)", "parse(raw: string, radix = 10)");
    r.git("commit", "-q", "-am", "change");
    const data = await impact(r, "main...feature");
    expect(data).toMatchObject({ head: "feature", changes: 1 });
    expect(data["base"]).toMatch(/^[0-9a-f]{40}$/);
    expect(data).not.toHaveProperty("warning");
    expect(changed(data)[0]).toMatchObject({ symbol: "parse", change: "signature" });
  });

  it("--staged analyses the index only", async () => {
    const r = repo();
    r.edit("src/services/parse.ts", "parse(raw: string)", "parse(raw: string, radix = 10)");
    r.git("add", "src/services/parse.ts");
    r.edit("src/models/user.ts", "this.secret = this.id;", "this.secret = String(this.id);");
    const data = await impact(r, "--staged");
    expect(data).toMatchObject({ head: "index", changes: 1 });
    expect(changed(data).map((c) => c["symbol"])).toEqual(["parse"]);
  });

  it("--grep adds unresolved textual matches that are not References", async () => {
    const r = repo();
    r.edit("src/services/parse.ts", "map(Number)", "map((n) => Number(n))");
    const data = await impact(r, "--grep");
    // `.parse(` calls of the parser methods are other Symbols' uses: textual matches by design.
    const unresolved = (data["unresolved"] as Rows).filter((row) => !/^src\/(parsers\/|services\/dates)/.test(String(row["file"])));
    expect(unresolved).toEqual([{ file: "src/services/parse.ts", line: 1, context: 'import { parse as parseList } from "../format/parse";' }]);
    expect(toon((await r.run("impact")).stdout)).not.toHaveProperty("unresolved");
  });

  it("--limit cuts ref rows across symbols and keeps exact totals", async () => {
    const r = repo();
    r.edit("src/models/user.ts", "this.secret = this.id;", "this.secret = String(this.id);");
    r.edit("src/services/parse.ts", "map(Number)", "map((n) => Number(n))");
    r.edit("src/services/sync.ts", "return list.filter", "return list.slice().filter");
    const data = await impact(r, "--limit", "3");
    const rows = data["refs"] as Rows;
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((x) => x["symbol"])).size).toBe(3);
    const total = changed(data).reduce((n, c) => n + (c["refs_outside"] as number), 0);
    expect(data).toMatchObject({ truncated: true, refs_shown: 3, refs_outside_total: total });
    expect(data["help"]).toEqual(expect.arrayContaining([expect.stringContaining(`ts-axi impact --fields all --limit ${total}`)]));
  });

  it("--depth 2 adds callers_depth2 counts per file", async () => {
    const r = repo();
    r.edit("src/models/user.ts", "this.secret = this.id;", "this.secret = String(this.id);");
    const data = await impact(r, "--depth", "2");
    expect(data["callers_depth2"]).toEqual(
      expect.arrayContaining([{ file: "src/services/sync.ts", count: 1 }, { file: "src/legacy/util.js", count: 1 }]),
    );
  });

  it("--json prints the same payload as JSON", async () => {
    const r = repo();
    r.edit("src/services/parse.ts", "parse(raw: string)", "parse(raw: string, radix = 10)");
    const data = JSON.parse((await r.run("impact", "--json")).stdout) as Payload;
    expect(data).toMatchObject({ changes: 1, blind_spots: 0 });
    expect(changed(data)[0]).toMatchObject({ change: "signature" });
    expect(data["help"]).toEqual(expect.any(Array));
  });

  it("a DateParser.parse body edit counts the direct call; the interface call is via", async () => {
    const r = repo();
    r.edit("src/parsers/date-parser.ts", "raw.slice(0, 10)", "raw.slice(0, 8)");
    const data = await impact(r);
    expect(changed(data)).toEqual([
      { symbol: "DateParser.parse", kind: "method", change: "body", exported: true, at: "src/parsers/date-parser.ts:4", refs_total: 1, refs_outside: 1, via: 1, files: 1, tests: 0 },
    ]);
    expect(refsOf(data, "DateParser.parse")).toEqual(["src/services/dates.ts:4"]);
    expect(data).not.toHaveProperty("notes");
    expect(data["help"]).toEqual(expect.arrayContaining([expect.stringContaining("ts-axi impact --fields all --via")]));
    const withVia = await impact(r, "--via");
    expect((withVia["refs"] as Rows).map((x) => `${x["file"]}:${x["line"]}:${x["via"]}`)).toEqual([
      "src/parsers/registry.ts:5:FieldParser.parse",
      "src/services/dates.ts:4:-",
    ]);
  });

  it("a signature change of an implementing method notes the interface it implements", async () => {
    const r = repo();
    r.edit("src/parsers/date-parser.ts", "parse(raw: string): string {", "parse(raw: string, strict = false): string {");
    const data = await impact(r);
    expect(changed(data)[0]).toMatchObject({ symbol: "DateParser.parse", change: "signature", refs_outside: 1, via: 1 });
    expect(data["notes"]).toEqual([{ symbol: "DateParser.parse", note: "implements FieldParser.parse" }]);
  });

  it("spec files outside tsconfig.lib.json point at the sibling tsconfig.json", async () => {
    const r = repo();
    r.write("tsconfig.lib.json", JSON.stringify({ extends: "./tsconfig.json", exclude: ["src/**/*.test.ts"] }));
    r.git("add", "tsconfig.lib.json");
    r.git("commit", "-q", "-m", "lib");
    r.edit("src/services/sync.ts", "return list.filter", "return list.slice().filter");
    r.edit("src/services/sync.test.ts", "=== 2", "=== 2 && true");
    const data = await impact(r, "-P", "tsconfig.lib.json");
    expect(data["skipped"]).toEqual([{ file: "src/services/sync.test.ts", reason: "not in the Project" }]);
    expect(data["help"]).toEqual(
      expect.arrayContaining(["Spec files are outside tsconfig.lib.json; run with -P tsconfig.json to count tests"]),
    );
  });

  it("a clean tree is a definitive changes: 0", async () => {
    const data = await impact(repo());
    expect(data).toMatchObject({ changes: 0 });
  });

  it("outside a git repo without stdin is GIT_ERROR (exit 1) pointing at impact -", async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "ts-axi-nogit-")));
    cpSync(FIXTURE, bare, { recursive: true });
    const { stdout, exitCode } = await runner(bare)("impact");
    expect(exitCode).toBe(1);
    expect(toon(stdout)).toMatchObject({ code: "GIT_ERROR" });
    expect(stdout).toContain("ts-axi impact -");
    rmSync(bare, { recursive: true, force: true });
  });

  it("rejects --staged with a range", async () => {
    expect((await repo().run("impact", "HEAD", "--staged")).exitCode).toBe(2);
  });

  it("an edit inside an array initializer is a body change; a new type annotation is a signature change", async () => {
    const r = repo();
    r.write("src/states.ts", "export const childStates = [\n  'idle',\n  'busy',\n];\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "states");
    r.edit("src/states.ts", "'busy',", "'busy',\n  'done',");
    const data = await impact(r);
    expect(data["local_only"]).toBe("1 (childStates body)");
    r.edit("src/states.ts", "childStates = [", "childStates: string[] = [");
    expect((await impact(r))["local_only"]).toBe("1 (childStates signature)");
  });

  describe("legacy JavaScript (no tsconfig)", () => {
    it("names the controller and the IIFE helper an edit touches", async () => {
      const r = repo(LEGACY_FIXTURE);
      r.edit("client/app.js", "$scope.items = [];", "$scope.items = [{ price: 0 }];");
      r.edit("lib/format.js", 'text = "0" + text;', 'text = " " + text;');
      const data = await impact(r);
      expect(data["warning"]).toContain("implicit project");
      expect(data).not.toHaveProperty("file_level");
      // CartCtrl is named by ng-controller in a template: not local.
      expect(changed(data)).toEqual([
        expect.objectContaining({ symbol: "pad", kind: "function", change: "body", exported: false, at: "lib/format.js:2", refs_outside: 2, templates: "-" }),
        expect.objectContaining({ symbol: "CartCtrl", change: "body", refs_outside: 0, templates: 1 }),
      ]);
    });

    it("a body edit of a function registered by identifier counts the registration's template usages", async () => {
      const r = repo(LEGACY_FIXTURE);
      r.edit("client/widgets.js", "$uibModal.open();", "$uibModal.open({});");
      expect(changed(await impact(r))).toEqual([expect.objectContaining({ symbol: "fancyBox", change: "body", templates: 2 })]);
    });

    it("a body edit of a nested function a service exposes through self names the member, with its DI use", async () => {
      const r = repo(LEGACY_FIXTURE);
      r.edit("client/item-store.js", 'return http.get("items/" + id);', 'return http.get("item/" + id);');
      const data = await impact(r);
      expect(data).not.toHaveProperty("file_level");
      expect(changed(data)).toEqual([expect.objectContaining({ symbol: "itemStore.loadItem", kind: "method", change: "body", at: "client/item-store.js:19", refs_outside: 0, textual: 1 })]);
    });

    it("a DI array or parameter change of a registration is a signature change", async () => {
      const r = repo(LEGACY_FIXTURE);
      r.edit("client/app.js", '["$scope", "priceService", function ($scope, priceService)', '["$scope", "taxService", function ($scope, priceService)');
      expect(changed(await impact(r))).toEqual([expect.objectContaining({ symbol: "CartCtrl", change: "signature", templates: 1 })]);
    });

    it("an edit inside a ui-router resolve callback names the callback, not file_level", async () => {
      const r = repo(LEGACY_FIXTURE);
      r.edit("client/states.js", "return response.data;", "return response.data || [];");
      const data = await impact(r);
      expect(data).not.toHaveProperty("file_level");
      const symbols = [...((data["changed"] as Rows | undefined) ?? []).map((c) => `${c["symbol"]} ${c["change"]}`), String(data["local_only"] ?? "")];
      expect(symbols.join(" | ")).toContain("states.cart.resolve.items body");
    });

    it("an edit inside a resolve of an exported state array names the resolve; a url edit is a signature change", async () => {
      const r = repo(LEGACY_FIXTURE);
      r.edit("client/outbound.states.js", "return res;", "return res.slice(0, 5);");
      const data = await impact(r);
      expect(data).not.toHaveProperty("file_level");
      const symbols = [...((data["changed"] as Rows | undefined) ?? []).map((c) => `${c["symbol"]} ${c["change"]}`), String(data["local_only"] ?? "")];
      expect(symbols.join(" | ")).toContain("states.main.warehouse.outbound.outboundInit.resolve.docks body");
      const u = repo(LEGACY_FIXTURE);
      u.edit("client/outbound.states.js", "url: '/init',", "url: '/start',");
      const url = await impact(u);
      const all = [...((url["changed"] as Rows | undefined) ?? []).map((c) => `${c["symbol"]} ${c["change"]}`), String(url["local_only"] ?? "")];
      expect(all.join(" | ")).toContain("states.main.warehouse.outbound.outboundInit signature");
    });

    it("a changed resolve key has no textual count and no blind spot from an unrelated .docks access", async () => {
      const r = repo(LEGACY_FIXTURE);
      expect(readFileSync(join(r.dir, "client/app.js"), "utf8")).toContain("view.docks");
      r.edit("client/outbound.states.js", "return res;", "return res.slice(0, 5);");
      const data = await impact(r);
      const row = "states.main.warehouse.outbound.outboundInit.resolve.docks body";
      expect(String(data["local_only"])).toContain(row);
      expect(JSON.stringify(data["changed"] ?? [])).not.toContain("resolve.docks");
      expect(data).not.toHaveProperty("textual_only");
      expect(JSON.stringify(data["blind_spots"] ?? [])).not.toContain("docks");
    });

    it("a state hook edit is local - the router calls it, not a name", async () => {
      const r = repo(LEGACY_FIXTURE);
      r.edit("client/states.js", "window.scrollTo(0, 0);", "window.scrollTo(0, 10);");
      expect((await impact(r))["local_only"]).toBe("1 (states.checkout.onEnter body)");
    });

    it("a directive binding change shows template usages; a changed template using it is a template_change", async () => {
      const r = repo(LEGACY_FIXTURE);
      r.edit("client/directives.js", 'fallbackDisplayProperty: "=",', 'fallbackDisplayProperty: "<",');
      const alone = await impact(r);
      expect(changed(alone)).toEqual([
        expect.objectContaining({ symbol: "wapSelect.fallbackDisplayProperty", kind: "property", change: "signature", templates: 2, tests: 0 }),
      ]);
      expect(alone).not.toHaveProperty("template_changes");
      r.edit("client/templates/cart.html", 'fallback-display-property="title"', 'fallback-display-property="label"');
      r.edit("client/templates/empty.html", "Nothing here", "Nothing yet");
      const both = await impact(r);
      expect(both["template_changes"]).toEqual([{ file: "client/templates/cart.html", symbols: "wapSelect.fallbackDisplayProperty" }]);
      expect(both["skipped"]).toEqual([{ file: "client/templates/empty.html", reason: "not TS or JS source" }]);
      const grep = await impact(r, "--grep");
      expect(grep["unresolved"]).toEqual(expect.arrayContaining([expect.objectContaining({ file: "client/templates/cart.html", line: 2 })]));
    });

    it("an expando method body edit is never local_only - its textual matches are counted", async () => {
      const r = repo(COMMONJS_FIXTURE);
      r.edit("lib/proto.js", "return '<' + view + '>';", "return '[' + view + ']';");
      const data = await impact(r);
      expect(changed(data)).toEqual([
        expect.objectContaining({ symbol: "app.render", change: "body", refs_outside: 1, textual: 4, tests: 0 }),
      ]);
      expect(data["help"]).toEqual(
        expect.arrayContaining(["Run `ts-axi impact --fields all --grep` for the 3 textual matches the checker cannot resolve (untyped JavaScript)"]),
      );
    });

    it("keeps the table narrow when the checker resolves every textual match", async () => {
      const r = repo(ESM_FIXTURE);
      r.edit("index.js", "return queue.splice(0);", "return queue.splice(0, queue.length);");
      const row = changed(await impact(r))[0]!;
      expect(row).toMatchObject({ symbol: "drain", refs_outside: 2, tests: 1 });
      expect(row).not.toHaveProperty("textual");
    });
  });
});

describe("plain JavaScript packages (no tsconfig)", () => {
  let cjs: (...argv: string[]) => Promise<RunResult>;
  let esm: (...argv: string[]) => Promise<RunResult>;
  beforeAll(() => {
    cjs = runner(fixtureCopy({ fixture: COMMONJS_FIXTURE }));
    esm = runner(fixtureCopy({ fixture: ESM_FIXTURE }));
  });

  it("callers follow require('..') through a module.exports = require() shim", async () => {
    const data = toon((await cjs("callers", "createApp")).stdout);
    expect(data).toMatchObject({ declared_at: "lib/app.js:7", refs_total: 3, files: 2, tests: 1 });
    expect((data["refs"] as Payload[]).map((r) => `${r["file"]}:${r["line"]}`)).toEqual(["examples/basic.js:5", "test/app.js:9", "test/app.js:14"]);
  });

  it("refs on an ESM default export reach importers of ./index.js despite index.d.ts", async () => {
    const data = toon((await esm("refs", "limitQueue")).stdout);
    expect(data).toMatchObject({ declared_at: "index.js:1", refs_total: 3, textual: "3 matches in 1 files", files: 1, tests: 1 });
    expect(data["help"]).not.toEqual(expect.arrayContaining([expect.stringContaining("--grep")]));
  });

  it("an expando member prints its textual count and the --grep hint", async () => {
    const data = toon((await cjs("refs", "app.render")).stdout);
    expect(data).toMatchObject({ declared_at: "lib/proto.js:11", refs_total: 1, textual: "4 matches in 3 files" });
    expect(data["help"]).toEqual(
      expect.arrayContaining(["Run `ts-axi refs lib/proto.js:11 --grep` for the 3 textual matches the checker cannot resolve (untyped JavaScript)"]),
    );
    const grep = toon((await cjs("refs", "app.render", "--grep")).stdout);
    expect((grep["unresolved"] as Payload[]).map((r) => `${r["file"]}:${r["line"]}`)).toEqual(["examples/basic.js:6", "test/app.js:10", "test/app.js:16"]);
  });

  it("the home view counts a root test.js as a Test file", async () => {
    expect(toon((await esm()).stdout)).toMatchObject({ source_files: 2, test_files: 1 });
  });
});

describe("legacy JavaScript outline / def / refs", () => {
  let legacy: (...argv: string[]) => Promise<RunResult>;
  beforeAll(() => {
    legacy = runner(fixtureCopy({ fixture: LEGACY_FIXTURE }));
  });
  const names = async (file: string) =>
    ((toon((await legacy("outline", file)).stdout)["decls"] as Payload[]) ?? []).map((d) => `${d["line"]} ${d["kind"]} ${d["name"]}`);

  it("outline lists nested declarations with qualified names", async () => {
    expect(await names("client/app.js")).toEqual(["6 function CartCtrl", "12 function priceService", "13 method priceService.sum", "17 function cartBadge", "22 function dockCount"]);
    expect(await names("client/methods.js")).toEqual([
      "2 method methods.addItem",
      "5 method methods.clearCart",
      "11 method Template.cartView.helpers.itemCount",
      "17 method Template.cartView.events.click .clear",
    ]);
    expect(await names("lib/ledger.js")).toEqual(["1 function Ledger", "4 method Ledger.reset", "9 method Ledger.add", "14 method Ledger.fromJSON"]);
    expect(await names("lib/format.js")).toEqual(["2 function pad", "8 function stamp"]);
    expect(await names("lib/totals.js")).toEqual(["1 variable TAX", "4 method exports.gross", "7 method exports.net", "12 method exports.round"]);
    const app = toon((await legacy("outline", "client/app.js", "--fields", "exported")).stdout)["decls"] as Payload[];
    expect(app[0]).toMatchObject({ exported: true, signature: "controller CartCtrl($scope, priceService)" });
  });

  it("def finds a function-valued member of a returned deps object, by name, Holder.member and --fuzzy", async () => {
    expect(await names("lib/services/access-guard.js")).toEqual([
      "2 function makeItemDeps",
      "6 method makeItemDeps.canReadItem",
      "9 method makeItemDeps.describeDeps",
      "16 function guard",
      "20 function fetchItem",
    ]);
    const def = await legacy("def", "canReadItem");
    expect(def.stdout).toContain("file: lib/services/access-guard.js\nline: 6\nkind: method");
    expect((await legacy("def", "makeItemDeps.canReadItem")).stdout).toContain("line: 6\nkind: method");
    expect((await legacy("def", "canreaditem", "--fuzzy")).stdout).toContain("file: lib/services/access-guard.js\nline: 6");
  });

  it("a line-only position names the declaration that starts the line, not its parameters; siblings stay ambiguous", async () => {
    expect(toon((await legacy("refs", "lib/services/access-guard.js:6")).stdout)).toMatchObject({ symbol: "makeItemDeps.canReadItem", kind: "method" });
    // Not indexed (an argument object): the function-valued property still outranks the callee and the arguments.
    expect(toon((await legacy("refs", "lib/services/access-guard.test.js:4")).stdout)).toMatchObject({ symbol: "canReadItem", declared_at: "lib/services/access-guard.test.js:4" });
    const siblings = toon((await legacy("refs", "lib/services/access-guard.test.js:10")).stdout);
    expect(siblings).toMatchObject({ ambiguous: "2 identifiers on the line - add a column" });
    expect(siblings["identifiers"]).toEqual([{ name: "firstId", line: 10, col: 7 }, { name: "lastId", line: 10, col: 20 }]);
  });

  it("a name with no Declaration: def and refs hint at its textual matches, refs --grep lists them", async () => {
    const def = toon((await legacy("def", "retries")).stdout);
    expect(def).toMatchObject({ matches: 0 });
    expect(def["help"]).toEqual(expect.arrayContaining(["Run `ts-axi refs retries --grep` for 1 textual matches"]));
    expect(toon((await legacy("refs", "retries")).stdout)["help"]).toEqual(expect.arrayContaining(["Run `ts-axi refs retries --grep` for 1 textual matches"]));
    const grep = await legacy("refs", "retries", "--grep");
    expect(grep.exitCode).toBe(0);
    expect(toon(grep.stdout)).toMatchObject({
      matches: 0,
      note: "no declaration found - textual matches only",
      unresolved: [{ file: "lib/services/access-guard.js", line: 12, context: "retries: 2," }],
    });
    expect(toon((await legacy("refs", "noSuchWordAnywhere", "--grep")).stdout)).toMatchObject({ matches: 0, unresolved: 0 });
    expect(toon((await legacy("def", "noSuchWordAnywhere")).stdout)["help"]).not.toEqual(expect.arrayContaining([expect.stringContaining("--grep")]));
  });

  it("def finds a controller by its registered name", async () => {
    const { stdout, exitCode } = await legacy("def", "CartCtrl");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("file: client/app.js\nline: 6\nkind: function\nexported: true");
    expect(fence(stdout)).toContain('.controller("CartCtrl"');
    expect(stdout).toContain("ts-axi refs client/app.js:6");
  });

  it("refs on a string-registered name explains it is textual and --grep finds the uses", async () => {
    const plain = toon((await legacy("refs", "client/app.js:6")).stdout);
    expect(plain).toMatchObject({ symbol: "CartCtrl", declared_at: "client/app.js:6", refs_total: 0 });
    expect(plain["note"]).toContain("registered by a string");
    expect(plain["help"]).toEqual(expect.arrayContaining([expect.stringContaining("ts-axi refs client/app.js:6 --grep")]));
    const grep = toon((await legacy("refs", "clearCart", "--grep")).stdout);
    expect(grep["unresolved"]).toEqual([{ file: "client/methods.js", line: 18, context: 'Meteor.call("clearCart", this._id);' }]);
  });

  it("outline lists ui-router states and their callbacks; directive bindings are properties", async () => {
    expect(await names("client/states.js")).toEqual([
      "1 function config",
      "5 state states.cart",
      "10 method states.cart.resolve.items",
      "17 state states.checkout",
      "22 method states.checkout.resolve.total",
      "26 method states.checkout.onEnter",
    ]);
    const states = toon((await legacy("outline", "client/states.js")).stdout)["decls"] as Payload[];
    expect(states[1]).toMatchObject({ kind: "state", signature: "state cart (url /cart)" });
    expect(await names("client/directives.js")).toEqual([
      "3 function wapSelect",
      "7 property wapSelect.fallbackDisplayProperty",
      "8 property wapSelect.items",
      "15 variable priceTag",
      "17 property priceTag.amount",
      "19 method priceTag.controller",
      "23 function money",
    ]);
    const def = await legacy("def", "states.cart", "--kind", "state");
    expect(def.stdout).toContain("file: client/states.js\nline: 5\nkind: state");
  });

  it("refs on a directive counts its template usages; --grep lists them", async () => {
    const plain = toon((await legacy("refs", "wapSelect")).stdout);
    expect(plain).toMatchObject({ symbol: "wapSelect", templates: "2 usages in 1 files" });
    expect(plain["help"]).toEqual(expect.arrayContaining(["Run `ts-axi refs client/directives.js:3 --grep` for the 2 template usages"]));
    const grep = toon((await legacy("refs", "wapSelect", "--grep")).stdout);
    expect(grep["unresolved"]).toEqual([
      { file: "client/templates/cart.html", line: 2, context: '<wap-select fallback-display-property="title" items="cart.items"></wap-select>' },
      { file: "client/templates/cart.html", line: 5, context: "<wap-select" },
    ]);
    const rows = async (target: string) =>
      ((toon((await legacy("refs", target, "--grep")).stdout)["unresolved"] as Payload[]) ?? []).filter((u) => String(u["file"]).endsWith(".html")).map((u) => `${u["file"]}:${u["line"]}`);
    expect(await rows("priceTag")).toEqual(["client/templates/cart.html:3"]);
    expect(await rows("priceTag.amount")).toEqual(["client/templates/cart.html:3"]);
    expect(await rows("money")).toEqual(["client/templates/cart.html:4"]);
    expect(await rows("client/app.js:6")).toEqual(["client/templates/cart.html:1"]);
    expect(toon((await legacy("refs", "wapSelect.items")).stdout)).toMatchObject({ templates: "1 usages in 1 files" });
  });

  it("a function registered by identifier gets the registration's templates, note and --grep rows", async () => {
    for (const target of ["client/widgets.js:6", "client/widgets.js:2", "fancyBox"]) {
      const data = toon((await legacy("refs", target)).stdout);
      expect(data, target).toMatchObject({ symbol: "fancyBox", declared_at: "client/widgets.js:6", templates: "2 usages in 1 files" });
      expect(data["note"], target).toContain("registered by a string");
    }
    const grep = toon((await legacy("refs", "fancyBox", "--grep")).stdout)["unresolved"] as Payload[];
    expect(grep.map((u) => `${u["file"]}:${u["line"]}`)).toEqual(["client/templates/panel.html:2", "client/templates/panel.html:3"]);
    // DI array form, function named differently from the registration.
    for (const target of ["client/widgets.js:16", "panelController", "PanelCtrl"]) {
      expect(toon((await legacy("refs", target)).stdout), target).toMatchObject({ symbol: "PanelCtrl", templates: "1 usages in 1 files" });
    }
    expect(toon((await legacy("refs", "fancyBox.boxTitle")).stdout)).toMatchObject({ templates: "1 usages in 1 files" });
  });

  it("self = this members and factory objects: outline lists nested functions once, data properties stay out", async () => {
    // The registration and the function it names share a line, as for fancyBox.
    expect(await names("client/item-store.js")).toEqual([
      "7 function itemStore",
      "7 function itemStore",
      "14 method itemStore.reset",
      "19 method itemStore.loadItem",
      "23 method itemStore.saveItem",
      "27 method itemStore.purgeItem",
    ]);
    expect(await names("client/item-factory.js")).toEqual([
      "4 function itemFactory",
      "17 function labelFactory",
      "4 function itemFactory",
      "8 method itemFactory.loadList",
      "12 method itemFactory.countItems",
      "17 function labelFactory",
      "20 method labelFactory.formatLabel",
      "24 method labelFactory.trimLabel",
    ]);
    // const and let aliases.
    expect(await names("client/shelf.controller.js")).toEqual([
      "4 function ShelfCtrl",
      "14 function BinCtrl",
      "4 function ShelfCtrl",
      "9 method ShelfCtrl.restock",
      "14 function BinCtrl",
      "18 method BinCtrl.empty",
    ]);
  });

  it("def finds a self member by Owner.member and by name, with the nested function's body", async () => {
    for (const target of ["itemStore.loadItem", "loadItem"]) {
      const { stdout } = await legacy("def", target);
      expect(stdout, target).toContain("file: client/item-store.js\nline: 19\nkind: method\nexported: true\nsignature: function loadItem(id)");
      expect(fence(stdout), target).toContain('return http.get("items/" + id);');
    }
    expect((await legacy("def", "purgeItem")).stdout).toContain("line: 27\nkind: method");
  });

  it("the function line and the aliasing line both resolve to the member; a shared shorthand line asks for a column", async () => {
    for (const target of ["client/item-store.js:19", "client/item-store.js:9", "client/item-store.js:9:24"]) {
      expect(toon((await legacy("refs", target)).stdout), target).toMatchObject({ symbol: "itemStore.loadItem", declared_at: "client/item-store.js:19" });
    }
    expect(toon((await legacy("refs", "client/shelf.controller.js:6")).stdout)).toMatchObject({ symbol: "ShelfCtrl.restock" });
    const shared = toon((await legacy("refs", "client/item-factory.js:18")).stdout);
    expect(shared["identifiers"]).toEqual([{ name: "formatLabel", line: 18, col: 14 }, { name: "trimLabel", line: 18, col: 40 }]);
    expect(toon((await legacy("refs", "client/item-factory.js:18:40")).stdout)).toMatchObject({ symbol: "labelFactory.trimLabel", declared_at: "client/item-factory.js:24" });
  });

  it("refs on a self member counts DI uses in other files textually and --grep lists them", async () => {
    const data = toon((await legacy("refs", "itemStore.loadItem")).stdout);
    // The aliasing line is part of the Declaration, not a use.
    expect(data).toMatchObject({ refs_total: 0, textual: "1 matches in 1 files" });
    expect(data["help"]).toEqual(
      expect.arrayContaining(["Run `ts-axi refs client/item-store.js:19 --grep` for the 1 textual matches the checker cannot resolve (untyped JavaScript)"]),
    );
    const grep = toon((await legacy("refs", "itemStore.loadItem", "--grep")).stdout);
    expect(grep["unresolved"]).toEqual([{ file: "client/item-view.controller.js", line: 6, context: "return itemStore.loadItem(id).then(function () {" }]);
    expect(toon((await legacy("refs", "itemFactory.loadList")).stdout)).toMatchObject({ textual: "1 matches in 1 files" });
  });

  it("a binding on a multi-line tag counts past a quoted '>' in an earlier attribute", async () => {
    const rows = ((toon((await legacy("refs", "wapSelect.fallbackDisplayProperty", "--grep")).stdout)["unresolved"] as Payload[]) ?? [])
      .filter((u) => String(u["file"]).endsWith(".html"))
      .map((u) => `${u["file"]}:${u["line"]}`);
    expect(rows).toEqual(["client/templates/cart.html:2", "client/templates/cart.html:8"]);
  });

  it("outline lists state objects of exported arrays with names built from same-file consts", async () => {
    expect(await names("client/outbound.states.js")).toEqual([
      "4 state states.main.warehouse.outbound.outboundInit",
      "9 method states.main.warehouse.outbound.outboundInit.resolve.docks",
      "15 state states.*.outboundDone",
      "21 state states.main.warehouse.outbound",
    ]);
    expect(await names("client/inbound.states.js")).toEqual(["2 state states.main.warehouse.inbound", "6 method states.main.warehouse.inbound.onEnter"]);
    const def = await legacy("def", "client/outbound.states.js:15");
    expect(def.stdout).toContain("file: client/outbound.states.js\nline: 15\nkind: state");
    expect(fence(def.stdout)).toContain("warehouseOutboundDone");
  });

  it("textual counts a non-exported local in its own file only", async () => {
    const local = toon((await legacy("refs", "lib/format.js:2")).stdout);
    expect(local).toMatchObject({ symbol: "pad", textual: "2 matches in this file" });
    const grep = toon((await legacy("refs", "lib/format.js:2", "--grep")).stdout);
    expect(((grep["unresolved"] as Payload[] | number | undefined) ?? 0)).toEqual(0);
  });

  it("textual counts project-wide for what leaves the file: a returned member, an argument object's property, a CommonJS export", async () => {
    const member = toon((await legacy("refs", "lib/services/access-guard.js:6")).stdout);
    expect(member).toMatchObject({ refs_total: 2, textual: "4 matches in 2 files" });
    expect(member["help"]).toEqual(expect.arrayContaining(["Run `ts-axi refs lib/services/access-guard.js:6 --grep` for the 2 textual matches the checker cannot resolve (untyped JavaScript)"]));
    expect(toon((await legacy("refs", "lib/services/access-guard.test.js:4")).stdout)).toMatchObject({ refs_total: 0, textual: "4 matches in 2 files" });
    expect(toon((await legacy("refs", "guard", "--in", "lib")).stdout)).toMatchObject({ textual: "4 matches in 2 files" });
    // Not in module.exports: its own file only.
    expect(toon((await legacy("refs", "fetchItem")).stdout)).toMatchObject({ textual: "1 matches in this file" });
    expect(toon((await legacy("refs", "TAX")).stdout)).toMatchObject({ textual: "2 matches in this file" });
  });

  it("refs on a state resolve key prints no textual line - the key is injected by name, not imported", async () => {
    const out = (await legacy("refs", "client/outbound.states.js:9")).stdout;
    expect(out).toContain("symbol: states.main.warehouse.outbound.outboundInit.resolve.docks");
    expect(out).not.toContain("textual:");
    expect(toon((await legacy("refs", "client/outbound.states.js:9", "--grep")).stdout)["unresolved"] ?? 0).toEqual(0);
  });

  it("a state's textual needle is its full dotted name, matched whole, templates included", async () => {
    const data = toon((await legacy("refs", "client/outbound.states.js:21")).stdout);
    expect(data["symbol"]).toBe("states.main.warehouse.outbound");
    // The name const in outbound.states.js and the exact ui-sref in cart.html; the child state name and the bare word 'outbound' do not count.
    expect(data["textual"]).toBe("2 matches in 2 files");
    const grep = toon((await legacy("refs", "client/outbound.states.js:21", "--grep")).stdout)["unresolved"] as Payload[];
    expect(grep.map((u) => `${u["file"]}:${u["line"]}`)).toEqual(["client/outbound.states.js:2", "client/templates/cart.html:11"]);
    // Unresolved parts (`*`) leave no needle: no textual line.
    expect((await legacy("refs", "client/outbound.states.js:15")).stdout).not.toContain("textual:");
  });

  it("refs on an IIFE helper goes through the LanguageService", async () => {
    const data = toon((await legacy("refs", "lib/format.js:2")).stdout);
    expect(data).toMatchObject({ declared_at: "lib/format.js:2", refs_total: 2, files: 1 });
  });
});

describe("ambiguous names", () => {
  let many: (...argv: string[]) => Promise<RunResult>;
  beforeAll(() => {
    const dir = fixtureCopy();
    for (let i = 0; i < 25; i++) {
      const sub = i < 15 ? "src/gen/alpha" : i < 22 ? "src/gen/beta" : "src/gen/gamma";
      mkdirSync(join(dir, sub), { recursive: true });
      const body = i % 5 === 0 ? `export class Repo${i} {\n  findOneByAlias(alias: string): string {\n    return alias;\n  }\n}\n` : `${i % 2 ? "export " : ""}function findOneByAlias(alias: string): string {\n  return alias;\n}\n`;
      writeFileSync(join(dir, sub, `m${String(i).padStart(2, "0")}.ts`), body);
    }
    many = runner(dir);
  });

  it.each(["def", "refs", "callers"])("%s caps the list at 20 and offers narrowing forms computed from the matches", async (command) => {
    const data = toon((await many(command, "findOneByAlias")).stdout);
    expect((data["matches"] as Payload[]).length).toBe(20);
    expect(data).toMatchObject({ matches_total: 25, truncated: true });
    const help = data["help"] as string[];
    expect(help).toEqual(
      expect.arrayContaining([
        `Run \`ts-axi ${command} findOneByAlias --in src/gen/alpha\` to keep 15 of 25`,
        `Run \`ts-axi ${command} findOneByAlias --in src/gen/beta\` to keep 7 of 25`,
        `Run \`ts-axi ${command} findOneByAlias --kind function\` to keep 20 of 25`,
        `Run \`ts-axi ${command} findOneByAlias --kind method\` to keep 5 of 25`,
        `Run \`ts-axi ${command} Repo0.findOneByAlias\` to keep 1 of 25`,
        `Run \`ts-axi ${command} findOneByAlias --exported\` to keep 15 of 25`,
      ]),
    );
  });
});

describe("workspace (Nx + pnpm fixture)", () => {
  const git = (dir: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });

  function workspace() {
    const dir = fixtureCopy({ fixture: WORKSPACE_FIXTURE });
    git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    return {
      dir,
      run: runner(dir),
      edit(rel: string, from: string, to: string) {
        const text = readFileSync(join(dir, rel), "utf8");
        expect(text).toContain(from);
        writeFileSync(join(dir, rel), text.replace(from, to));
      },
    };
  }
  const files = (data: Payload, key = "refs") => [...new Set((data[key] as Payload[]).map((r) => r["file"]))].sort();
  const SCOPE = /^nx workspace - \d+ of 7 files \(seeds 1; importers \d+\)$/;

  let ws: ReturnType<typeof workspace>;
  beforeAll(() => {
    ws = workspace();
  });

  it("home view names the workspace kind and its projects", async () => {
    const data = toon((await ws.run()).stdout);
    expect(data).toMatchObject({ workspace: "nx (4 projects)", tsconfig: "nearest per file - workspace scope", source_files: 7 });
  });

  it("refs without -P finds uses in every project through the alias and the barrel", async () => {
    const data = toon((await ws.run("refs", "formatMoney")).stdout);
    expect(data).toMatchObject({ declared_at: "libs/shared/src/lib/money.ts:6", tests: 1, files: 4 });
    expect(data["warning"]).toBeUndefined();
    expect(data["scope"]).toMatch(SCOPE);
    expect(files(data)).toEqual([
      "apps/web/src/main.ts",
      "services/billing/src/invoice.spec.ts",
      "services/billing/src/invoice.ts",
      "services/reports/src/summary.ts",
    ]);
    expect((data["refs"] as Payload[]).find((r) => r["file"] === "services/reports/src/summary.ts" && r["line"] === 3)).toBeDefined();
  });

  it("callers excludes the type-only use", async () => {
    const data = toon((await ws.run("callers", "formatMoney")).stdout);
    expect(files(data)).toEqual(["apps/web/src/main.ts", "services/billing/src/invoice.spec.ts", "services/billing/src/invoice.ts"]);
    expect(data["scope"]).toMatch(SCOPE);
  });

  it("callers under -P of the lib config is empty and points at the importers outside it", async () => {
    const { stdout } = await ws.run("callers", "formatMoney", "-P", "libs/shared/tsconfig.lib.json");
    const data = toon(stdout);
    expect(data["refs_total"]).toBe(0);
    expect(data["scope"]).toBeUndefined();
    expect(files(data, "found_outside_project")).toEqual(["apps/web/src/main.ts", "services/billing/src/invoice.spec.ts", "services/billing/src/invoice.ts", "services/reports/src/summary.ts"]);
    expect(data["hint"]).toBe("4 files outside the selected project import it - run without -P for workspace scope");
    expect(stdout).toContain("Run `ts-axi callers formatMoney` without -P");
  });

  it("a references-only tsconfig under -P expands to its lib and spec configs", async () => {
    const shell = toon((await ws.run("refs", "roundCents", "-P", "libs/shared/tsconfig.json")).stdout);
    expect(shell).toMatchObject({ tsconfig: "libs/shared/tsconfig.json (2 referenced configs)", refs_total: 2, tests: 1 });
    expect(files(shell)).toEqual(["libs/shared/src/lib/money.spec.ts"]);
    const lib = toon((await ws.run("refs", "roundCents", "-P", "libs/shared/tsconfig.lib.json")).stdout);
    expect(lib["refs_total"]).toBe(0);
    expect(lib["tsconfig"]).toBeUndefined();
  });

  it("impact -P on the references shell analyses the spec file instead of skipping it", async () => {
    const r = workspace();
    r.edit("libs/shared/src/lib/money.spec.ts", "roundCents(1.5) === 2", "roundCents(2.5) === 3");
    const data = toon((await r.run("impact", "-P", "libs/shared/tsconfig.json")).stdout);
    expect(data["skipped"]).toBeUndefined();
    expect(data["tsconfig"]).toBe("libs/shared/tsconfig.json (2 referenced configs)");
  });

  it("impact of a body edit lists References across both services and the app", async () => {
    const r = workspace();
    r.edit("libs/shared/src/lib/money.ts", "money.cents / 100", "Math.trunc(money.cents) / 100");
    const data = toon((await r.run("impact", "--fields", "all")).stdout);
    expect(data["changed"]).toEqual([
      expect.objectContaining({ symbol: "formatMoney", change: "body", exported: true, files: 4, tests: 1 }),
    ]);
    expect(files(data)).toEqual(["apps/web/src/main.ts", "services/billing/src/invoice.spec.ts", "services/billing/src/invoice.ts", "services/reports/src/summary.ts"]);
    expect(data["scope"]).toMatch(/^nx workspace - \d+ of 7 files \(seeds 1; importers \d+\)$/);
  });

  it("impact of a signature change lists the type-only use as a ref; callers does not", async () => {
    const r = workspace();
    r.edit("libs/shared/src/lib/money.ts", "formatMoney(money: Money)", "formatMoney(money: Money, locale = 'en')");
    const data = toon((await r.run("impact")).stdout);
    expect((data["changed"] as Payload[])[0]).toMatchObject({ symbol: "formatMoney", change: "signature" });
    expect(files(data)).toContain("services/reports/src/summary.ts");
    const callers = toon((await r.run("callers", "formatMoney")).stdout);
    expect(files(callers)).not.toContain("services/reports/src/summary.ts");
  });
});

describe("anchor", () => {
  const gitIn = (dir: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "core.quotepath=true", ...args], { cwd: dir, encoding: "utf8" });
  const numbered = (n: number): string => Array.from({ length: n }, (_, i) => `    const v${i + 1} = ${i + 1};`).join("\n");

  // One class; edits at line 5 and line 31 give two -U3 hunks (new 2-8 and 28-33).
  const LEDGER = [
    "export class Ledger {",
    "  private rows: number[] = [];",
    "",
    "  add(n: number): void {",
    "    this.rows.push(n);",
    "  }",
    "",
    "  sum(): number {",
    numbered(18),
    "    return this.rows.reduce((a, b) => a + b, 0);",
    "  }",
    "",
    "  clear(): void {",
    "    this.rows = [];",
    "  }",
    "}",
    "",
  ].join("\n");

  /** main = base commit; feature = two edits, a rename, an added, a deleted, a binary and a non-ASCII file. */
  function repo() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ts-axi-anchor-")));
    const write = (rel: string, text: string | Buffer) => {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    gitIn(dir, "init", "-q");
    gitIn(dir, "symbolic-ref", "HEAD", "refs/heads/main");
    write("src/ledger.ts", LEDGER);
    write("src/old-name.ts", `export function moved(): number {\n  return 1;\n}\n${numbered(10)}\n`);
    write("src/gone.ts", "export const gone = 1;\nexport const alsoGone = 2;\n");
    write("assets/logo.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
    write("src/naïve.ts", "export const a = 1;\n");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-q", "-m", "base");
    gitIn(dir, "checkout", "-q", "-b", "feature");
    write("src/ledger.ts", LEDGER.replace("    this.rows.push(n);", "    if (n !== 0) this.rows.push(n);").replace("    this.rows = [];", "    this.rows.length = 0;"));
    gitIn(dir, "mv", "src/old-name.ts", "src/new-name.ts");
    write("src/new-name.ts", `export function moved(): number {\n  return 2;\n}\n${numbered(10)}\n`);
    write("src/fresh.ts", "export function fresh(): string {\n  return 'x';\n}\n");
    rmSync(join(dir, "src/gone.ts"));
    write("assets/logo.bin", Buffer.from([0, 9, 9, 9, 0, 255]));
    write("src/naïve.ts", "export const a = 2;\n");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-q", "-m", "feature");
    return { dir, run: runner(dir), git: (...args: string[]) => gitIn(dir, ...args), write };
  }
  type Row = { anchor: string; ok: boolean; reason: string; symbol: string; [k: string]: unknown };
  const rowsOf = (stdout: string): Row[] => toon(stdout)["anchors"] as Row[];

  let r: ReturnType<typeof repo>;
  beforeAll(() => {
    r = repo();
  });

  it("checks anchors against a range at -U3: added, context, off-diff and absent", async () => {
    const { stdout, exitCode } = await r.run("anchor", "main...feature", "src/ledger.ts:5", "src/ledger.ts:3", "src/ledger.ts:15", "src/ledger.ts:30-32", "src/other.ts:1");
    expect(exitCode).toBe(3);
    const data = toon(stdout);
    expect(data).toMatchObject({ head: "feature", context: 3, side: "new", invalid: 2 });
    expect(data["base"]).toMatch(/^[0-9a-f]{40}$/);
    expect(rowsOf(stdout)).toEqual([
      { anchor: "src/ledger.ts:5", ok: true, reason: "-", symbol: "Ledger.add#method" },
      { anchor: "src/ledger.ts:3", ok: true, reason: "-", symbol: "Ledger#class" },
      { anchor: "src/ledger.ts:15", ok: false, reason: "not in diff - nearest 2-8", symbol: "Ledger.sum#method" },
      { anchor: "src/ledger.ts:30-32", ok: true, reason: "-", symbol: "Ledger.clear#method" },
      { anchor: "src/other.ts:1", ok: false, reason: "file not in diff", symbol: "-" },
    ]);
    expect(data["help"]).toEqual(expect.arrayContaining([
      "Move src/ledger.ts:15 into src/ledger.ts:2-8 or post it as a general comment",
      expect.stringContaining("exit 3 (ANCHOR_INVALID) - 2 of 5"),
      "Run `ts-axi anchor main...feature src/ledger.ts:15 src/other.ts:1 --fields all` for in_diff, in_file, nearest, change and other_line",
    ]));
  });

  it("--fields all adds in_diff, in_file, nearest, change and other_line; exit 0 when all pass", async () => {
    const { stdout, exitCode } = await r.run("anchor", "main...feature", "src/ledger.ts:5", "src/ledger.ts:6", "--fields", "all");
    expect(exitCode).toBe(0);
    expect(rowsOf(stdout)).toEqual([
      { anchor: "src/ledger.ts:5", ok: true, reason: "-", symbol: "Ledger.add#method", in_diff: true, in_file: true, nearest: "-", change: "body", other_line: "-" },
      { anchor: "src/ledger.ts:6", ok: true, reason: "-", symbol: "Ledger.add#method", in_diff: true, in_file: true, nearest: "-", change: "body", other_line: 6 },
    ]);
    expect(toon(stdout)["invalid"]).toBe(0);
  });

  it("--context 0 shrinks the hunks to the changed lines", async () => {
    const rows = rowsOf((await r.run("anchor", "main...feature", "src/ledger.ts:5", "src/ledger.ts:4", "--context", "0")).stdout);
    expect(rows.map((x) => [x.ok, x.reason])).toEqual([[true, "-"], [false, "not in diff - nearest 5"]]);
  });

  it("renamed, added, deleted, binary and non-ASCII (quoted) files", async () => {
    const { stdout } = await r.run(
      "anchor", "main...feature",
      "src/new-name.ts:2", "src/old-name.ts:2", "src/fresh.ts:1-3", "src/gone.ts:1", "assets/logo.bin:1", "src/naïve.ts:1",
    );
    expect(rowsOf(stdout).map((x) => [x.anchor, x.ok, x.reason, x.symbol])).toEqual([
      ["src/new-name.ts:2", true, "-", "moved#function"],
      ["src/old-name.ts:2", true, "-", "moved#function"],
      ["src/fresh.ts:1-3", true, "-", "fresh#function"],
      ["src/gone.ts:1", false, "removed line - use --side old", "-"],
      ["assets/logo.bin:1", false, "binary", "-"],
      ["src/naïve.ts:1", true, "-", "a#variable"],
    ]);
  });

  it("--side old checks the before file under the old path", async () => {
    const { stdout, exitCode } = await r.run("anchor", "main...feature", "src/ledger.ts:5", "src/old-name.ts:2", "src/gone.ts:1-2", "src/fresh.ts:1", "--side", "old", "--fields", "change");
    expect(exitCode).toBe(3);
    expect(rowsOf(stdout).map((x) => [x.anchor, x.ok, x.reason, x.symbol, x["change"]])).toEqual([
      ["src/ledger.ts:5", true, "-", "Ledger.add#method", "body"],
      ["src/old-name.ts:2", true, "-", "moved#function", "body"],
      ["src/gone.ts:1-2", true, "-", "file_level", "-"],
      ["src/fresh.ts:1", false, "file added - use --side new", "-", "-"],
    ]);
  });

  it("reads a diff from stdin as given, with --json and exit 3", async () => {
    const diff = r.git("diff", "-U3", "main...feature");
    let stdout = "";
    process.exitCode = 0;
    await main({ argv: ["anchor", "-", "src/ledger.ts:5", "src/ledger.ts:14", "--json"], cwd: r.dir, stdin: diff, stdout: { write: (c: string) => (stdout += c) } });
    expect(process.exitCode).toBe(3);
    process.exitCode = 0;
    const data = JSON.parse(stdout) as Payload;
    expect(data).toMatchObject({ base: "stdin diff", side: "new", invalid: 1 });
    expect(data).not.toHaveProperty("context");
    expect(data["anchors"]).toEqual([
      { anchor: "src/ledger.ts:5", ok: true, reason: "-", symbol: "Ledger.add#method" },
      { anchor: "src/ledger.ts:14", ok: false, reason: "not in diff - nearest 2-8", symbol: "Ledger.sum#method" },
    ]);
  });

  it("warns when a stdin diff does not match the checkout", async () => {
    const diff = r.git("diff", "-U3", "main...feature", "--", "src/ledger.ts");
    r.git("checkout", "-q", "main");
    try {
      let stdout = "";
      await main({ argv: ["anchor", "-", "src/ledger.ts:5"], cwd: r.dir, stdin: diff, stdout: { write: (c: string) => (stdout += c) } });
      process.exitCode = 0;
      expect(toon(stdout)["warning"]).toMatch(/^1 files in the stdin diff do not match the working tree/);
      expect(rowsOf(stdout)).toEqual([{ anchor: "src/ledger.ts:5", ok: true, reason: "-", symbol: "-" }]);
    } finally {
      r.git("checkout", "-q", "feature");
    }
  });

  it("--staged and the working tree (untracked files count as added)", async () => {
    const w = repo();
    w.write("src/ledger.ts", LEDGER.replace("  sum(): number {", "  sum(): number { // staged"));
    w.git("add", "src/ledger.ts");
    w.write("src/scratch.ts", "export const s = 1;\n");
    const staged = await w.run("anchor", "--staged", "src/ledger.ts:8", "src/scratch.ts:1");
    expect(toon(staged.stdout)).toMatchObject({ base: "HEAD", head: "index" });
    expect(rowsOf(staged.stdout).map((x) => x.reason)).toEqual(["-", "file not in diff"]);
    const tree = await w.run("anchor", "src/ledger.ts:8", "src/scratch.ts:1");
    expect(tree.exitCode).toBe(0);
    expect(toon(tree.stdout)).toMatchObject({ head: "working tree" });
    expect(rowsOf(tree.stdout).map((x) => x.symbol)).toEqual(["Ledger.sum#method", "s#variable"]);
  });

  it("usage errors: no anchors, source after anchors, column, --context with -, --staged with a range", async () => {
    const cases: Array<[string[], RegExp]> = [
      [["anchor", "main...feature"], /no anchors given/],
      [["anchor", "src/ledger.ts:5", "main...feature"], /'main...feature' is not an anchor/],
      [["anchor", "main...feature", "src/ledger.ts:5:3"], /has a column/],
      [["anchor", "-", "src/ledger.ts:5", "--context", "1"], /--context applies to git diffs/],
      [["anchor", "--staged", "main...feature", "src/ledger.ts:5"], /--staged cannot be combined/],
      [["anchor", "main...feature", "src/ledger.ts:5", "--side", "left"], /invalid --side/],
      [["anchor", "main...feature", "src/ledger.ts:5", "-P", "tsconfig.json"], /unknown flag -P/],
    ];
    for (const [argv, message] of cases) {
      const { stdout, exitCode } = await r.run(...argv);
      expect(exitCode, argv.join(" ")).toBe(2);
      expect(stdout).toMatch(message);
    }
    const swapped = toon((await r.run("anchor", "src/ledger.ts:5", "main...feature")).stdout);
    expect(swapped["help"]).toEqual(["the diff source goes first: `ts-axi anchor main...feature src/ledger.ts:5`"]);
  });
});

describe("References through mock mapped types", () => {
  const MOCK_LINES = [6, 7, 8, 12, 13, 14, 15];
  const specLines = (rows: Payload[]): number[] =>
    rows.filter((r) => String(r["file"]).endsWith(".spec.ts")).map((r) => Number(r["line"]));

  it("refs counts every mock shape and keeps a same-named sibling out", async () => {
    const run = runner(fixtureCopy({ fixture: MOCKS_FIXTURE }));
    const data = toon((await run("refs", "ItemService.findItem")).stdout);
    expect(data).toMatchObject({ refs_total: 8, files: 2, tests: 1 });
    const rows = data["refs"] as Payload[];
    expect(specLines(rows)).toEqual(MOCK_LINES);
    // OtherService.findItem: the consumer's line 11 and the spec's line 19.
    expect(rows.some((r) => r["line"] === 11 || r["line"] === 19)).toBe(false);
  });

  it("callers lists the mock uses with the test function", async () => {
    const run = runner(fixtureCopy({ fixture: MOCKS_FIXTURE }));
    const rows = toon((await run("callers", "ItemService.findItem")).stdout)["refs"] as Payload[];
    expect(specLines(rows)).toEqual(MOCK_LINES);
    expect(rows.find((r) => r["line"] === 6)?.["caller"]).toBe("deepMocked");
  });

  it("impact counts mocking specs as tests of a signature change", async () => {
    const dir = committed(MOCKS_FIXTURE);
    const file = join(dir, "src/items/item.service.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace("async findItem(id: number): Promise<string> {\n    return `item", "async findItem(id: number, fresh = false): Promise<string> {\n    return `item"));
    const data = toon((await runner(dir)("impact", "--fields", "all")).stdout);
    const row = (data["changed"] as Payload[]).find((r) => r["symbol"] === "ItemService.findItem");
    expect(row).toMatchObject({ change: "signature", refs_outside: 8, files: 2, tests: 1 });
  });
});
