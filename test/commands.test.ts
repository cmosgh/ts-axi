import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { beforeAll, describe, expect, it } from "vitest";
import { fixtureCopy, runner, type RunResult } from "./helpers.js";

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

  it("impact is a stub until phase 3", async () => {
    const { stdout, exitCode } = await run("impact");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("impact: not implemented yet");
  });
});
