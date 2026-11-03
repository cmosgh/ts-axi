import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { FIXTURE, fixtureCopy, runner, type RunResult } from "./helpers.js";

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
    expect(decls.find((d) => d["name"] === "User.secret")).toMatchObject({ kind: "property", exported: false });
    expect(decls.find((d) => d["name"] === "User.save")).toMatchObject({ line: 13, kind: "method", exported: true, signature: "save(): boolean" });
    expect(stdout).toContain("ts-axi def src/models/user.ts:5");
  });

  it("--exported over a glob adds the file column and drops private members", async () => {
    const data = toon((await run("outline", "src/models/*.ts", "--exported")).stdout);
    const decls = data["decls"] as Payload[];
    expect(data["files"]).toBe(3);
    expect(decls.every((d) => d["exported"] === true)).toBe(true);
    expect(decls.some((d) => d["name"] === "User.secret")).toBe(false);
    expect(decls.find((d) => d["name"] === "Role")).toMatchObject({ file: "src/models/types.ts", kind: "enum" });
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
    const { stdout, exitCode } = await run("def", "parse");
    expect(exitCode).toBe(0);
    const data = toon(stdout);
    expect(data["matches"]).toEqual([
      { file: "src/format/parse.ts", line: 1, kind: "function", exported: true, signature: "export function parse(input: string): string[]" },
      { file: "src/services/parse.ts", line: 3, kind: "function", exported: true, signature: "export function parse(raw: string): number[]" },
    ]);
    expect(stdout).toContain("ts-axi def src/format/parse.ts:1");
    expect(stdout).toContain("ts-axi def parse --in src/format");
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
    const { stdout, exitCode } = await run("refs", "parse");
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

  it.each(["def", "refs", "callers", "outline", "impact", "config"])("%s --help and -h print usage", async (command) => {
    for (const flag of ["--help", "-h"]) {
      const { stdout, exitCode } = await run(command, flag);
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(new RegExp(`^usage: ts-axi ${command}`));
    }
  });

  it("top-level --help lists the commands", async () => {
    expect((await run("--help")).stdout).toContain("def, refs, callers, outline, impact, config");
  });

});

describe("impact", () => {
  type Rows = Payload[];
  const git = (dir: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });

  /** A fixture copy on branch main with one commit, plus file editing helpers. */
  function repo() {
    const dir = fixtureCopy();
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

  async function impact(r: ReturnType<typeof repo>, ...argv: string[]): Promise<Payload> {
    const { stdout, exitCode } = await r.run("impact", ...argv);
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
      { symbol: "User.save", kind: "method", change: "body", exported: true, at: "src/models/user.ts:13", refs_total: 2, refs_outside: 2, files: 2, tests: 0 },
    ]);
    expect(refsOf(data, "User.save")).toEqual(["src/legacy/util.js:5", "src/services/sync.ts:13"]);
    expect(data["elapsed_ms"]).toEqual(expect.any(Number));
    expect(data["help"]).toEqual(expect.arrayContaining([expect.stringContaining("ts-axi refs src/models/user.ts:13")]));
  });

  it("puts the any access and the string key in src/dynamic.ts in blind_spots", async () => {
    const r = repo();
    r.edit("src/models/user.ts", "this.secret = this.id;", "this.secret = String(this.id);");
    const data = await impact(r);
    expect(data["blind_spots"]).toEqual([
      { symbol: "User.save", file: "src/dynamic.ts", line: 4, reason: "property access on any" },
      { symbol: "User.save", file: "src/dynamic.ts", line: 5, reason: "string key 'save' on a type without that member" },
    ]);
    expect(data["help"]).toEqual(expect.arrayContaining([expect.stringContaining("ts-axi impact --grep")]));
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
    expect(data["unresolved"]).toEqual([{ file: "src/services/parse.ts", line: 1, context: 'import { parse as parseList } from "../format/parse";' }]);
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
    expect(data["help"]).toEqual(expect.arrayContaining([expect.stringContaining(`ts-axi impact --limit ${total}`)]));
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

  it("a clean tree is a definitive changes: 0", async () => {
    const data = await impact(repo());
    expect(data).toMatchObject({ changes: 0 });
  });

  it("outside a git repo without stdin is GIT_ERROR (exit 3) pointing at impact -", async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "ts-axi-nogit-")));
    cpSync(FIXTURE, bare, { recursive: true });
    const { stdout, exitCode } = await runner(bare)("impact");
    expect(exitCode).toBe(3);
    expect(toon(stdout)).toMatchObject({ code: "GIT_ERROR" });
    expect(stdout).toContain("ts-axi impact -");
    rmSync(bare, { recursive: true, force: true });
  });

  it("rejects --staged with a range", async () => {
    expect((await repo().run("impact", "HEAD", "--staged")).exitCode).toBe(2);
  });
});
