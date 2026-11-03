// Workspace detection (no configuration): which kind of repo this is, its projects,
// path aliases and workspace packages. Reads files only; never writes, never caches.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { matchesGlob } from "./glob.js";
import { listFiles, toRel } from "./walk.js";

export type WorkspaceKind = "nx" | "pnpm-workspaces" | "npm-workspaces" | "tsconfig-references" | "single" | "implicit";
export type TsconfigRole = "root" | "base" | "lib" | "app" | "spec" | "e2e" | "other";

/** Most specific first. */
const KIND_ORDER: readonly WorkspaceKind[] = ["nx", "pnpm-workspaces", "npm-workspaces", "tsconfig-references", "single", "implicit"];
const MULTI: ReadonlySet<WorkspaceKind> = new Set(["nx", "pnpm-workspaces", "npm-workspaces", "tsconfig-references"]);

export const WORKSPACE_SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] as const;
const LIST_CAP = 200_000;

export interface WorkspaceProject {
  name: string;
  /** Absolute. */
  dir: string;
  /** Absolute paths of every `tsconfig*.json` directly in `dir`. */
  tsconfigs: string[];
}

export interface PathAliases {
  /** The tsconfig declaring `paths`. */
  file: string;
  /** Absolute directory the `paths` targets are relative to (`baseUrl`, else the tsconfig's directory). */
  base: string;
  paths: Record<string, string[]>;
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  /** Export subpath (`.`, `./money`, `./*`) → absolute candidate targets, best first. */
  exports: Record<string, string[]>;
}

export interface Workspace {
  root: string;
  kind: WorkspaceKind;
  /** Every kind that applies, most specific first. */
  signals: WorkspaceKind[];
  projects: WorkspaceProject[];
  paths?: PathAliases;
  packages: WorkspacePackage[];
  /** Absolute source files (gitignore-aware when the root is a git repo), sorted. */
  sourceFiles: string[];
  listedBy: "git" | "walk";
}

export function isMultiProject(kind: WorkspaceKind): boolean {
  return MULTI.has(kind);
}

const KIND_LABELS: Record<WorkspaceKind, string> = {
  nx: "nx workspace",
  "pnpm-workspaces": "pnpm workspace",
  "npm-workspaces": "npm workspace",
  "tsconfig-references": "tsconfig references",
  single: "single project",
  implicit: "implicit project",
};

export function kindLabel(kind: WorkspaceKind): string {
  return KIND_LABELS[kind];
}

/** JSON with comments and trailing commas (tsconfig style); undefined when unreadable. */
export function readJsonc(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let outText = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      outText += text.slice(start, i + 1);
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      outText += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else outText += ch;
  }
  try {
    const value: unknown = JSON.parse(outText.replace(/,(\s*[}\]])/g, "$1"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function isSourceName(name: string): boolean {
  return WORKSPACE_SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !/\.d\.[mc]?ts$/.test(name);
}

/** Repo-root-relative files of the workspace (shared listing, `src/walk.ts`). */
export function listWorkspaceFiles(root: string): { files: string[]; listedBy: "git" | "walk" } {
  const listing = listFiles(root, () => true, { maxFiles: LIST_CAP });
  return { files: listing.files.map((f) => toRel(root, f)), listedBy: listing.listedBy };
}

/** Role of a tsconfig by its name, then by its `include` patterns. */
export function classifyTsconfig(path: string): TsconfigRole {
  const name = basename(path);
  if (name === "tsconfig.json") return "root";
  if (/^tsconfig\.base\./.test(name)) return "base";
  if (/(?:^|\.)lib(?:\.|$)/.test(name.replace(/^tsconfig\./, "").replace(/\.json$/, ""))) return "lib";
  if (/\.app\.json$/.test(name)) return "app";
  if (/\.(?:spec|test|tests|vitest|jest)\.json$/.test(name)) return "spec";
  if (/\.(?:e2e|cy|cypress|playwright)\.json$/.test(name)) return "e2e";
  const include = readJsonc(path)?.["include"];
  const patterns = Array.isArray(include) ? include.filter((p): p is string => typeof p === "string") : [];
  if (patterns.some((p) => /e2e|\.cy\./.test(p))) return "e2e";
  if (patterns.some((p) => /\.(?:spec|test)\.|__tests__/.test(p))) return "spec";
  return "other";
}

function tsconfigsIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => /^tsconfig.*\.json$/.test(n))
      .map((n) => join(dir, n))
      .sort();
  } catch {
    return [];
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** `packages:` list of a pnpm-workspace.yaml (block or flow style). */
export function pnpmPackageGlobs(text: string): string[] {
  const globs: string[] = [];
  const lines = text.split(/\r?\n/);
  const unquote = (s: string): string => s.trim().replace(/^['"]|['"]$/g, "");
  for (let i = 0; i < lines.length; i++) {
    const m = /^packages\s*:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const inline = m[1]!.replace(/#.*$/, "").trim();
    if (inline.startsWith("[")) return inline.replace(/^\[|\]$/g, "").split(",").map(unquote).filter((g) => g !== "");
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!.replace(/#.*$/, "");
      if (line.trim() === "") continue;
      const item = /^\s+-\s*(.+)$/.exec(line);
      if (!item) break;
      globs.push(unquote(item[1]!));
    }
  }
  return globs;
}

/** Directories (repo-relative) holding a `package.json` that match workspace globs (`!` negates). */
function matchPackageDirs(globs: string[], packageDirs: string[]): string[] {
  const positive = globs.filter((g) => !g.startsWith("!")).map((g) => g.replace(/^\.\//, "").replace(/\/$/, ""));
  const negative = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1).replace(/^\.\//, "").replace(/\/$/, ""));
  return packageDirs.filter((d) => d !== "" && positive.some((g) => matchesGlob(d, g)) && !negative.some((g) => matchesGlob(d, g)));
}

/** The first string target of an `exports` condition object, preferring source-ish conditions. */
function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const order = ["source", "development", "types", "import", "module", "default", "require", "node"];
    const keys = [...order.filter((k) => k in record), ...Object.keys(record).filter((k) => !order.includes(k))];
    return keys.flatMap((k) => exportTargets(record[k]));
  }
  return [];
}

function readPackage(dir: string): WorkspacePackage | undefined {
  const pkg = readJsonc(join(dir, "package.json"));
  const name = pkg?.["name"];
  if (!pkg || typeof name !== "string" || name === "") return undefined;
  const exportsMap: Record<string, string[]> = {};
  const add = (sub: string, targets: string[]): void => {
    exportsMap[sub] = [...(exportsMap[sub] ?? []), ...targets.map((t) => resolve(dir, t))];
  };
  const raw = pkg["exports"];
  if (typeof raw === "string" || Array.isArray(raw)) add(".", exportTargets(raw));
  else if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    if (Object.keys(record).some((k) => k.startsWith("."))) {
      for (const [sub, target] of Object.entries(record)) if (sub.startsWith(".")) add(sub, exportTargets(target));
    } else add(".", exportTargets(record));
  }
  const fields = ["source", "types", "typings", "module", "main"].map((k) => pkg[k]).filter((v): v is string => typeof v === "string");
  add(".", [...fields, "src/index", "index"]);
  return { name, dir, exports: exportsMap };
}

/** `compilerOptions.paths` of tsconfig.base.json (else tsconfig.json), following relative `extends`. */
export function readPathAliases(root: string): PathAliases | undefined {
  const start = [join(root, "tsconfig.base.json"), join(root, "tsconfig.json")].find((f) => existsSync(f));
  let file = start;
  for (let hops = 0; file && hops < 5; hops++) {
    const config = readJsonc(file);
    if (!config) return undefined;
    const options = (config["compilerOptions"] ?? {}) as Record<string, unknown>;
    const paths = options["paths"];
    if (paths && typeof paths === "object" && !Array.isArray(paths)) {
      const clean: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(paths as Record<string, unknown>)) clean[k] = stringArray(v);
      const baseUrl = typeof options["baseUrl"] === "string" ? (options["baseUrl"] as string) : undefined;
      return { file, base: resolve(dirname(file), baseUrl ?? "."), paths: clean };
    }
    const ext = config["extends"];
    const next = typeof ext === "string" && ext.startsWith(".") ? resolve(dirname(file), ext) : undefined;
    file = next && !next.endsWith(".json") && !existsSync(next) ? `${next}.json` : next;
  }
  return undefined;
}

/** Root tsconfig with `references` and no files/include of its own. */
function referencesOnly(config: Record<string, unknown> | undefined): boolean {
  if (!config) return false;
  const refs = config["references"];
  const own = (key: string): boolean => Array.isArray(config[key]) && (config[key] as unknown[]).length > 0;
  return Array.isArray(refs) && refs.length > 0 && !own("files") && !own("include");
}

function project(root: string, relDir: string, name?: string): WorkspaceProject {
  const dir = relDir === "" ? root : join(root, relDir);
  return { name: name ?? (relDir || basename(root)), dir, tsconfigs: tsconfigsIn(dir) };
}

/** Cheap pre-check (no file listing): could `root` be a multi-project workspace? */
export function hasMultiProjectSignal(root: string): boolean {
  if (existsSync(join(root, "nx.json")) || existsSync(join(root, "pnpm-workspace.yaml"))) return true;
  if (readJsonc(join(root, "package.json"))?.["workspaces"] !== undefined) return true;
  return referencesOnly(readJsonc(join(root, "tsconfig.json")));
}

export function detectWorkspace(root: string): Workspace {
  const { files, listedBy } = listWorkspaceFiles(root);
  const dirsWith = (fileName: string): string[] =>
    files.filter((f) => f === fileName || f.endsWith(`/${fileName}`)).map((f) => (f === fileName ? "" : f.slice(0, -fileName.length - 1)));
  const packageDirs = dirsWith("package.json");
  const signals: WorkspaceKind[] = [];
  const byKind = new Map<WorkspaceKind, WorkspaceProject[]>();

  if (existsSync(join(root, "nx.json"))) {
    signals.push("nx");
    const projects = dirsWith("project.json").map((d) => {
      const name = readJsonc(join(root, d, "project.json"))?.["name"];
      return project(root, d, typeof name === "string" ? name : undefined);
    });
    const legacy = readJsonc(join(root, "workspace.json"))?.["projects"];
    if (legacy && typeof legacy === "object") {
      for (const [name, value] of Object.entries(legacy as Record<string, unknown>)) {
        const dir = typeof value === "string" ? value : (value as { root?: unknown } | null)?.root;
        if (typeof dir === "string" && !projects.some((p) => p.dir === join(root, dir))) projects.push(project(root, dir.replace(/\/$/, ""), name));
      }
    }
    byKind.set("nx", projects);
  }
  const pnpmFile = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpmFile)) {
    const globs = pnpmPackageGlobs(readFileSync(pnpmFile, "utf8"));
    if (globs.length > 0) {
      signals.push("pnpm-workspaces");
      byKind.set("pnpm-workspaces", matchPackageDirs(globs, packageDirs).map((d) => project(root, d, readPackage(join(root, d))?.name)));
    }
  }
  const rootPkg = readJsonc(join(root, "package.json"));
  const ws = rootPkg?.["workspaces"];
  const npmGlobs = Array.isArray(ws) ? stringArray(ws) : stringArray((ws as { packages?: unknown } | undefined)?.packages);
  if (npmGlobs.length > 0) {
    signals.push("npm-workspaces");
    byKind.set("npm-workspaces", matchPackageDirs(npmGlobs, packageDirs).map((d) => project(root, d, readPackage(join(root, d))?.name)));
  }
  const rootTsconfig = join(root, "tsconfig.json");
  const rootConfig = existsSync(rootTsconfig) ? readJsonc(rootTsconfig) : undefined;
  if (referencesOnly(rootConfig)) {
    signals.push("tsconfig-references");
    const refs = (rootConfig!["references"] as Array<{ path?: unknown }>).map((r) => r.path).filter((p): p is string => typeof p === "string");
    const dirs = refs.map((p) => {
      const abs = resolve(root, p);
      return existsSync(abs) && statSync(abs).isFile() ? dirname(abs) : abs;
    });
    byKind.set("tsconfig-references", [...new Set(dirs)].map((d) => project(root, relative(root, d).split(sep).join("/"))));
  } else if (existsSync(rootTsconfig)) {
    signals.push("single");
    byKind.set("single", [project(root, "")]);
  }
  if (signals.length === 0) signals.push("implicit");
  signals.sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
  const kind = signals[0]!;

  // Workspace packages: package.json with a name in any project dir or matched workspace dir.
  const pkgDirs = new Set<string>();
  for (const list of byKind.values()) for (const p of list) if (p.dir !== root && existsSync(join(p.dir, "package.json"))) pkgDirs.add(p.dir);
  const packages = [...pkgDirs].map(readPackage).filter((p): p is WorkspacePackage => p !== undefined);
  const paths = readPathAliases(root);

  return {
    root,
    kind,
    signals,
    projects: (byKind.get(kind) ?? []).sort((a, b) => a.dir.localeCompare(b.dir)),
    ...(paths ? { paths } : {}),
    packages,
    sourceFiles: files.filter((f) => isSourceName(f)).map((f) => join(root, f)),
    listedBy,
  };
}
