import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { findLocals } from "../src/commands/miss.js";
import { committed, EXCLUDED_FIXTURE, fixtureCopy, runIn, runner, WORKSPACE_FIXTURE, type RunResult } from "./helpers.js";

type Payload = Record<string, unknown>;

let run: (...argv: string[]) => Promise<RunResult>;

beforeAll(() => {
  run = runner(fixtureCopy({ fixture: EXCLUDED_FIXTURE }));
});

const toon = (stdout: string): Payload => decode(stdout, { strict: true }) as Payload;

/** The TOON header above the `body:` fence. */
function head(stdout: string): Payload {
  return toon(stdout.split("\nbody:\n")[0]!);
}

describe("findLocals", () => {
  const parse = (text: string): ts.SourceFile => ts.createSourceFile("a.ts", text, ts.ScriptTarget.Latest, true);
  const owners = (text: string, name: string): string[] => findLocals(parse(text), name).map((l) => l.owner);

  it("finds functions, classes and plain bindings nested in a function, named by their owner", () => {
    const text = [
      "export function Comp() { function onTap() {} const onTap2 = () => 1; class Box {} }",
      "class View { render() { let onTap = 1; } }",
      "export const Hook = () => { useEffect(() => { var onTap = 2; }); };",
    ].join("\n");
    expect(owners(text, "onTap")).toEqual(["Comp", "View.render", "Hook"]);
    expect(owners(text, "Box")).toEqual(["Comp"]);
    expect(owners(text, "onTap2")).toEqual(["Comp"]);
  });

  it("skips top-level and namespace Declarations, parameters, destructured and loop bindings", () => {
    const text = [
      "function top() {}",
      "namespace NS { export function top() {} }",
      "function f(top: number) { const { top: x } = o; const [top2] = a; for (const top of xs) {} }",
    ].join("\n");
    expect(owners(text, "top")).toEqual([]);
    expect(owners(text, "top2")).toEqual([]);
  });

  it("names a block outside any function", () => {
    expect(owners("if (x) { function inBlock() {} }", "inBlock")).toEqual(["(top-level block)"]);
  });
});

describe("def miss fallback", () => {
  it("shows a Declaration in a file the tsconfig excludes, with the Deno reason", async () => {
    const { stdout, exitCode } = await run("def", "handleEdge");
    expect(exitCode).toBe(0);
    expect(head(stdout)).toMatchObject({ file: "edge/fn/core.ts", line: 3, kind: "function", project: "outside (Deno edge/fn/deno.json)" });
    expect(stdout).toContain("   4 |   return input.slice(0, EDGE_LIMIT);");
    expect(stdout).toContain("ts-axi refs edge/fn/core.ts:3:17");
  });

  it("names the Project tsconfig when no Deno config sits above the file", async () => {
    const dir = fixtureCopy({ fixture: EXCLUDED_FIXTURE });
    rmSync(join(dir, "edge/fn/deno.json"));
    expect(head((await runIn(dir, "def", "EDGE_LIMIT")).stdout)).toMatchObject({ kind: "variable", project: "outside (not in tsconfig.json)" });
  });

  it("names a left-out file's own tsconfig", async () => {
    const dir = fixtureCopy({ fixture: EXCLUDED_FIXTURE });
    mkdirSync(join(dir, "tools"));
    writeFileSync(join(dir, "tools/tsconfig.json"), "{}\n");
    writeFileSync(join(dir, "tools/gen.ts"), "export function generate(): number {\n  return 1;\n}\n");
    expect(head((await runIn(dir, "def", "generate")).stdout)).toMatchObject({ file: "tools/gen.ts", project: "outside (own tsconfig tools/tsconfig.json)" });
  });

  it("shows a function-local Declaration with its enclosing function", async () => {
    const { stdout } = await run("def", "onTap");
    expect(head(stdout)).toMatchObject({ file: "src/comp.ts", line: 3, kind: "function", exported: false, local_to: "Comp" });
    expect(stdout).toContain("   4 |     console.log(handler.label);");
    expect(stdout).toContain("ts-axi callers src/comp.ts:3:12");
  });

  it("lists several locals as rows with position hints", async () => {
    const { stdout } = await run("def", "onPress");
    expect(toon(stdout)).toMatchObject({
      symbol: "onPress",
      matches: [
        { at: "src/comp.ts:11:12", kind: "function", name: "onPress", where: "local to Primary" },
        { at: "src/comp.ts:18:9", kind: "function", name: "onPress", where: "local to Secondary" },
      ],
    });
    expect(stdout).toContain("ts-axi def src/comp.ts:11:12");
  });

  it("applies --kind and --in to the fallback", async () => {
    expect(toon((await run("def", "handler", "--kind", "function")).stdout)).toMatchObject({ matches: 0 });
    expect(head((await run("def", "handler", "--kind", "variable")).stdout)).toMatchObject({ local_to: "Comp" });
    expect(toon((await run("def", "handleEdge", "--in", "src")).stdout)).toMatchObject({ matches: 0 });
    expect(head((await run("def", "handleEdge", "--in", "edge")).stdout)).toMatchObject({ file: "edge/fn/core.ts" });
  });

  it("keeps a real miss as it was", async () => {
    expect(toon((await run("def", "absentName")).stdout)).toEqual({ matches: 0, help: ["Run `ts-axi def absentName --fuzzy` for substring matches"] });
  });

  it("counts left-out files in the --grep hint", async () => {
    const { stdout } = await run("def", "served", "--kind", "function");
    expect(stdout).toContain("Run `ts-axi refs served --grep` for 2 textual matches (2 in files outside the Project)");
  });

  it("reads the git tree under --ref", async () => {
    const dir = committed(EXCLUDED_FIXTURE);
    rmSync(join(dir, "edge"), { recursive: true });
    rmSync(join(dir, "src/comp.ts"));
    expect(head((await runIn(dir, "def", "handleEdge", "--ref", "HEAD")).stdout.replace(/^ref: .*\n/, ""))).toMatchObject({ file: "edge/fn/core.ts" });
    expect(head((await runIn(dir, "def", "onTap", "--ref", "HEAD")).stdout.replace(/^ref: .*\n/, ""))).toMatchObject({ local_to: "Comp" });
    expect((await runIn(dir, "outline", "edge/**", "--ref", "HEAD")).stdout).toContain("note: 2 files outside the Project");
  });
});

describe("refs and callers miss fallback", () => {
  it("runs a local through the semantic path", async () => {
    const data = toon((await run("refs", "onTap")).stdout);
    expect(data).toMatchObject({ symbol: "onTap", declared_at: "src/comp.ts:3:12", local_to: "Comp", refs_total: 2 });
    expect((data["refs"] as Payload[]).map((r) => r["line"])).toEqual([6, 7]);
  });

  it("callers of a local name the enclosing function", async () => {
    const data = toon((await run("callers", "onTap")).stdout);
    expect(data).toMatchObject({ local_to: "Comp", refs_total: 2 });
    expect((data["refs"] as Payload[]).map((r) => r["caller"])).toEqual(["Comp", "Comp"]);
  });

  it("answers a left-out Declaration with its textual rows and the position target", async () => {
    const { stdout } = await run("refs", "handleEdge");
    const data = toon(stdout);
    expect(data).toMatchObject({
      matches: 0,
      declared_at: "edge/fn/core.ts:3",
      project: "outside (Deno edge/fn/deno.json)",
      outside_project: "3 matches in 2 files (edge/fn)",
    });
    expect((data["unresolved"] as Payload[]).map((r) => `${r["file"]}:${r["line"]}`)).toEqual(["edge/fn/core.ts:9", "edge/fn/index.ts:1", "edge/fn/index.ts:4"]);
    expect(stdout).toContain("ts-axi refs edge/fn/core.ts:3:17");
  });

  it("the position target in a left-out file finds References in the other left-out files", async () => {
    const data = toon((await run("refs", "edge/fn/core.ts:3:17")).stdout);
    expect(data).toMatchObject({ symbol: "handleEdge", project: "outside (Deno edge/fn/deno.json)", refs_total: 3, files: 2 });
    const callers = toon((await run("callers", "edge/fn/core.ts:3:17")).stdout);
    expect((callers["refs"] as Payload[]).map((r) => r["caller"])).toEqual(["EdgeQueue.push", "(top-level)"]);
  });

  it("--grep on a miss counts the left-out files", async () => {
    const data = toon((await run("refs", "served", "--kind", "function", "--grep")).stdout);
    expect(data).toMatchObject({ matches: 0, outside_project: "2 matches in 1 files (edge/fn)" });
  });

  it("several locals give rows, nothing analysed", async () => {
    const { stdout } = await run("callers", "onPress");
    expect(toon(stdout)).toMatchObject({ matches: [{ where: "local to Primary" }, { where: "local to Secondary" }] });
    expect(stdout).toContain("ts-axi callers src/comp.ts:18:9");
  });

  it("--in a left-out directory goes to the fallback", async () => {
    expect(toon((await run("refs", "EdgeQueue", "--in", "edge")).stdout)).toMatchObject({ matches: 0, project: "outside (Deno edge/fn/deno.json)" });
  });
});

describe("outline over left-out files", () => {
  it("falls back to repo source files that match the glob", async () => {
    const data = toon((await run("outline", "edge/**")).stdout);
    expect(data).toMatchObject({ files: 2, note: "2 files outside the Project" });
    expect((data["decls"] as Payload[]).map((d) => d["name"])).toContain("handleEdge");
  });
});

describe("workspace", () => {
  it("a file a workspace tsconfig owns is not outside", async () => {
    const dir = fixtureCopy({ fixture: WORKSPACE_FIXTURE });
    // money.spec.ts is excluded by tsconfig.lib.json but owned by tsconfig.spec.json.
    const { stdout } = await runIn(join(dir, "apps/web"), "def", "roundsHalfUp");
    expect(head(stdout)).toMatchObject({ file: "libs/shared/src/lib/money.spec.ts" });
    expect(head(stdout)["project"]).toBeUndefined();
  });
});
