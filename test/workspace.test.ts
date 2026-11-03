import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildImporterIndex, createResolver, extractImports, importerClosure } from "../src/importers.js";
import { findRepoRoot, openProject, walkSourceFiles } from "../src/project.js";
import { semanticFor } from "../src/scope.js";
import { listFiles, walkFiles } from "../src/walk.js";
import { classifyTsconfig, detectWorkspace, pnpmPackageGlobs, readPathAliases } from "../src/workspace.js";

/** A temp tree from `{ "rel/path": "text" }`; not a git repo unless `git` is set. */
function tree(files: Record<string, string>, options: { git?: boolean } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ts-axi-ws-")));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  if (options.git) execFileSync("git", ["init", "-q", "."], { cwd: dir, stdio: "ignore" });
  return dir;
}

const json = (value: unknown): string => JSON.stringify(value);

describe("detectWorkspace", () => {
  it("nx: projects are the project.json dirs; pnpm and references stay as signals", () => {
    const dir = tree({
      "nx.json": "{}",
      "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n",
      "tsconfig.json": json({ files: [], references: [{ path: "./libs/a" }] }),
      "libs/a/project.json": json({ name: "lib-a" }),
      "libs/a/package.json": json({ name: "@x/a" }),
      "libs/a/tsconfig.json": "{}",
      "libs/a/tsconfig.lib.json": "{}",
      "apps/b/project.json": "{}",
      "apps/b/src/main.ts": "export {};\n",
    });
    const ws = detectWorkspace(dir);
    expect(ws.kind).toBe("nx");
    expect(ws.signals).toEqual(["nx", "pnpm-workspaces", "tsconfig-references"]);
    expect(ws.projects.map((p) => p.name)).toEqual(["apps/b", "lib-a"]);
    expect(ws.projects[1]!.tsconfigs.map((t) => t.slice(dir.length + 1))).toEqual(["libs/a/tsconfig.json", "libs/a/tsconfig.lib.json"]);
    expect(ws.packages.map((p) => p.name)).toEqual(["@x/a"]);
    expect(ws.listedBy).toBe("walk");
  });

  it("nx legacy workspace.json lists projects by name", () => {
    const dir = tree({ "nx.json": "{}", "workspace.json": json({ projects: { api: "apps/api", ui: { root: "apps/ui" } } }) });
    expect(detectWorkspace(dir).projects.map((p) => p.name)).toEqual(["api", "ui"]);
  });

  it("pnpm-workspaces: packages globs with negation", () => {
    const dir = tree({
      "pnpm-workspace.yaml": "packages:\n  - \"packages/*\"\n  - '!packages/skip'\n",
      "packages/one/package.json": json({ name: "one" }),
      "packages/skip/package.json": json({ name: "skip" }),
    });
    const ws = detectWorkspace(dir);
    expect(ws.kind).toBe("pnpm-workspaces");
    expect(ws.projects.map((p) => p.name)).toEqual(["one"]);
  });

  it("npm-workspaces: package.json workspaces (array or object form)", () => {
    for (const workspaces of [["pkgs/*"], { packages: ["pkgs/*"] }]) {
      const dir = tree({ "package.json": json({ name: "root", workspaces }), "pkgs/a/package.json": json({ name: "a" }) });
      const ws = detectWorkspace(dir);
      expect(ws.kind).toBe("npm-workspaces");
      expect(ws.packages.map((p) => p.name)).toEqual(["a"]);
    }
  });

  it("tsconfig-references: a root tsconfig with references and no files of its own", () => {
    const dir = tree({
      "tsconfig.json": json({ files: [], references: [{ path: "./a" }, { path: "./b/tsconfig.app.json" }] }),
      "a/tsconfig.json": "{}",
      "b/tsconfig.app.json": "{}",
    });
    const ws = detectWorkspace(dir);
    expect(ws.kind).toBe("tsconfig-references");
    expect(ws.projects.map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("single and implicit", () => {
    expect(detectWorkspace(tree({ "tsconfig.json": json({ include: ["src"] }), "src/a.ts": "" })).kind).toBe("single");
    expect(detectWorkspace(tree({ "src/a.ts": "" })).kind).toBe("implicit");
  });

  it("classifies tsconfigs by name, then by include patterns", () => {
    const dir = tree({ "tsconfig.other.json": json({ include: ["src/**/*.spec.ts"] }), "tsconfig.plain.json": "{}" });
    expect(classifyTsconfig("/x/tsconfig.json")).toBe("root");
    expect(classifyTsconfig("/x/tsconfig.base.json")).toBe("base");
    expect(classifyTsconfig("/x/tsconfig.lib.json")).toBe("lib");
    expect(classifyTsconfig("/x/tsconfig.app.json")).toBe("app");
    expect(classifyTsconfig("/x/tsconfig.spec.json")).toBe("spec");
    expect(classifyTsconfig("/x/tsconfig.e2e.json")).toBe("e2e");
    expect(classifyTsconfig(join(dir, "tsconfig.other.json"))).toBe("spec");
    expect(classifyTsconfig(join(dir, "tsconfig.plain.json"))).toBe("other");
  });

  it("reads pnpm globs in block and flow style, and paths with comments and baseUrl", () => {
    expect(pnpmPackageGlobs("packages: ['a/*', \"b\"]\n")).toEqual(["a/*", "b"]);
    expect(pnpmPackageGlobs("# x\npackages:\n  - a/* # libs\n\ncatalog:\n  - nope\n")).toEqual(["a/*"]);
    const dir = tree({ "tsconfig.base.json": '{\n  // c\n  "compilerOptions": { "baseUrl": "src", "paths": { "@a/*": ["lib/*"], }, },\n}' });
    expect(readPathAliases(dir)).toEqual({ file: join(dir, "tsconfig.base.json"), base: join(dir, "src"), paths: { "@a/*": ["lib/*"] } });
  });
});

describe("file walks", () => {
  const files = {
    "src/a.ts": "",
    "nested/.git/HEAD": "ref: refs/heads/main\n",
    "nested/src/copy.ts": "",
    ".claude/worktrees/x/src/copy.ts": "",
    ".vscode/x.ts": "",
    "node_modules/p/index.js": "",
  };

  it("the fs fallback skips nested checkouts and tool directories", () => {
    const dir = tree(files);
    expect(walkFiles(dir, { accept: () => true }).files.map((f) => f.slice(dir.length + 1)).sort()).toEqual(["src/a.ts"]);
    expect(listFiles(dir, () => true).listedBy).toBe("walk");
  });

  it("inside git one ls-files listing is used and never enters a nested repo", () => {
    const { "nested/.git/HEAD": _fake, ...rest } = files;
    const dir = tree(rest, { git: true });
    execFileSync("git", ["init", "-q", "nested"], { cwd: dir, stdio: "ignore" });
    const listing = listFiles(dir, (n) => n.endsWith(".ts"));
    expect(listing.listedBy).toBe("git");
    expect(listing.files.map((f) => f.slice(dir.length + 1))).toEqual(["src/a.ts"]);
    expect(walkSourceFiles(dir).map((f) => f.slice(dir.length + 1))).toEqual(["src/a.ts"]);
  });

  it("a linked worktree (.git file) is its own root", () => {
    const dir = tree({ ".git/HEAD": "", "wt/.git": "gitdir: ../.git/worktrees/wt\n", "wt/src/a.ts": "" });
    expect(findRepoRoot(join(dir, "wt", "src"))).toBe(join(dir, "wt"));
  });
});

describe("importers", () => {
  it("extracts static, side-effect, require, dynamic and mock specifiers; marks re-exports", () => {
    const text = [
      'import { a } from "./a";',
      "import type {",
      "  B,",
      "} from '@x/b';",
      'import "./side";',
      'export * from "./barrel";',
      'export { c } from "./c";',
      'const d = require("./d");',
      'const e = await import("./e");',
      'vi.mock("./f");',
    ].join("\n");
    expect(extractImports(text)).toEqual([
      { spec: "./a", reexport: false, line: 1 },
      { spec: "@x/b", reexport: false, line: 4 },
      { spec: "./side", reexport: false, line: 5 },
      { spec: "./barrel", reexport: true, line: 6 },
      { spec: "./c", reexport: true, line: 7 },
      { spec: "./d", reexport: false, line: 8 },
      { spec: "./e", reexport: false, line: 9 },
      { spec: "./f", reexport: false, line: 10 },
    ]);
  });

  const root = "/r";
  const set = new Set([
    "/r/libs/shared/src/index.ts",
    "/r/libs/shared/src/lib/money.ts",
    "/r/libs/ui/src/button.tsx",
    "/r/pkgs/kit/src/index.ts",
    "/r/pkgs/kit/src/sub/tool.ts",
    "/r/pkgs/kit/src/extra.ts",
    "/r/app/main.ts",
    "/r/app/esm.ts",
  ]);
  const resolve = createResolver(
    {
      paths: { file: "/r/tsconfig.base.json", base: root, paths: { "@acme/shared": ["libs/shared/src/index.ts"], "@acme/ui/*": ["libs/ui/src/*"] } },
      packages: [{ name: "@acme/kit", dir: "/r/pkgs/kit", exports: { ".": ["/r/pkgs/kit/dist/index.js"], "./extra": ["/r/pkgs/kit/src/extra.ts"] } }],
    },
    set,
  );

  it("resolves relative (with .js and index), aliases, package names and subpaths; ignores the rest", () => {
    expect(resolve("./esm.js", "/r/app/main.ts")).toBe("/r/app/esm.ts");
    expect(resolve("../libs/shared/src", "/r/app/main.ts")).toBe("/r/libs/shared/src/index.ts");
    expect(resolve("@acme/shared", "/r/app/main.ts")).toBe("/r/libs/shared/src/index.ts");
    expect(resolve("@acme/ui/button", "/r/app/main.ts")).toBe("/r/libs/ui/src/button.tsx");
    expect(resolve("@acme/kit", "/r/app/main.ts")).toBe("/r/pkgs/kit/src/index.ts");
    expect(resolve("@acme/kit/extra", "/r/app/main.ts")).toBe("/r/pkgs/kit/src/extra.ts");
    expect(resolve("@acme/kit/sub/tool", "/r/app/main.ts")).toBe("/r/pkgs/kit/src/sub/tool.ts");
    expect(resolve("react", "/r/app/main.ts")).toBeUndefined();
    expect(resolve("./missing", "/r/app/main.ts")).toBeUndefined();
  });

  it("follows barrel chains without spending a hop; plain importers spend one", () => {
    const texts: Record<string, string> = {
      "/r/libs/shared/src/lib/money.ts": "export const m = 1;\n",
      "/r/libs/shared/src/index.ts": 'export * from "./lib/money";\n',
      "/r/libs/all.ts": 'export * from "./shared/src";\n',
      "/r/app/main.ts": 'import { m } from "@acme/shared";\n',
      "/r/app/deep.ts": 'import { m } from "../libs/all";\n',
      "/r/app/second.ts": 'import "./main";\n',
    };
    const files = Object.keys(texts);
    const index = buildImporterIndex(files, (f) => texts[f], createResolver({ paths: { file: "", base: root, paths: { "@acme/shared": ["libs/shared/src/index.ts"] } }, packages: [] }, new Set(files)));
    expect(index.partial).toBe(false);
    const one = importerClosure(index, ["/r/libs/shared/src/lib/money.ts"], 1);
    expect(one.importers).toEqual(["/r/app/deep.ts", "/r/app/main.ts", "/r/libs/all.ts", "/r/libs/shared/src/index.ts"]);
    expect(one.barrels).toEqual(["/r/libs/all.ts", "/r/libs/shared/src/index.ts"]);
    expect(importerClosure(index, ["/r/libs/shared/src/lib/money.ts"], 2).importers).toContain("/r/app/second.ts");
    expect(buildImporterIndex(files, (f) => texts[f], () => undefined, { maxFiles: 2 })).toMatchObject({ partial: true, scanned: 2, total: 6 });
  });
});

describe("large implicit project", () => {
  it("over 3000 files without a tsconfig, semantic commands use the importer subgraph", () => {
    const files: Record<string, string> = { "src/core.ts": "export function core(): number {\n  return 1;\n}\n", "src/use.ts": 'import { core } from "./core";\nexport const v = core();\n' };
    for (let i = 0; i < 3000; i++) files[`src/gen/f${i}.ts`] = `export const g${i} = ${i};\n`;
    const dir = tree(files);
    mkdirSync(join(dir, ".git"));
    const ctx = openProject(dir);
    expect(ctx.warning).toBe("no tsconfig.json found - implicit project");
    expect(ctx.index.project.scope?.kind).toBe("implicit");
    const { semantic, scope } = semanticFor(ctx, [join(dir, "src/core.ts")], 1);
    expect(scope?.line).toBe("implicit project - 2 of 3002 files (seeds 1; importers 1)");
    const sf = semantic.program.getSourceFile(join(dir, "src/core.ts"))!;
    expect(semantic.findReferences(join(dir, "src/core.ts"), sf.text.indexOf("core")).filter((r) => !r.isDefinition).map((r) => r.file)).toEqual(["src/use.ts", "src/use.ts"]);
  });
});
