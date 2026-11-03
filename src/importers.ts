// Syntactic reverse-import graph (regex over file text, no AST): which workspace files import
// a given file, through relative paths, `paths` aliases, workspace package names and barrels.
import { dirname, resolve } from "node:path";
import type { PathAliases, WorkspacePackage } from "./workspace.js";

export interface ImportEdge {
  spec: string;
  /** `export * from` / `export { x } from`: the importer re-exports the target (a barrel). */
  reexport: boolean;
  /** 1-based line of the specifier. */
  line: number;
}

const PATTERNS: Array<{ re: RegExp; reexport: boolean }> = [
  { re: /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\1/g, reexport: true },
  { re: /\bimport\s+(?:type\s+)?[^'";]*?\bfrom\s*(['"])([^'"\n]+)\1/g, reexport: false },
  { re: /\bimport\s*(['"])([^'"\n]+)\1/g, reexport: false },
  { re: /\b(?:require|import|(?:vi|jest)\.(?:mock|doMock|requireActual|importActual))\s*\(\s*(['"])([^'"\n]+)\1/g, reexport: false },
];

/** Static specifiers of `import`/`export ... from`, side-effect imports, `require()`, `import()`, `vi.mock()`. */
export function extractImports(text: string): ImportEdge[] {
  if (!/\b(?:import|export|require|mock)\b/.test(text)) return [];
  const edges = new Map<number, ImportEdge>();
  let lineStarts: number[] | undefined;
  const lineAt = (offset: number): number => {
    lineStarts ??= [0, ...[...text.matchAll(/\n/g)].map((m) => m.index! + 1)];
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const { re, reexport } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const specOffset = m.index! + m[0].lastIndexOf(m[2]!);
      // A position matched by an earlier (re-export) pattern keeps that classification.
      if (!edges.has(specOffset)) edges.set(specOffset, { spec: m[2]!, reexport, line: lineAt(specOffset) });
    }
  }
  return [...edges.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
}

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export interface ResolverInput {
  paths?: PathAliases;
  packages: readonly WorkspacePackage[];
}

export type Resolve = (spec: string, fromFile: string) => string | undefined;

/** Resolves a specifier to a file of `files` (absolute paths); anything else (node_modules, builtins) is undefined. */
export function createResolver(input: ResolverInput, files: ReadonlySet<string>): Resolve {
  const tryPath = (p: string, depth = 0): string | undefined => {
    if (files.has(p)) return p;
    const stem = p.replace(/\.(?:d\.)?[mc]?[jt]sx?$/, "");
    for (const ext of EXTENSIONS) if (files.has(stem + ext)) return stem + ext;
    for (const ext of EXTENSIONS) if (files.has(`${p}/index${ext}`)) return `${p}/index${ext}`;
    // Build output in a package manifest: look for the source next to it.
    if (depth === 0 && /[\\/](?:dist|build|lib|out)[\\/]/.test(p)) return tryPath(p.replace(/([\\/])(?:dist|build|lib|out)([\\/])/, "$1src$2"), 1);
    return undefined;
  };

  const aliases = Object.entries(input.paths?.paths ?? {})
    .map(([pattern, targets]) => {
      const star = pattern.indexOf("*");
      return { pattern, targets, prefix: star < 0 ? pattern : pattern.slice(0, star), suffix: star < 0 ? "" : pattern.slice(star + 1), wildcard: star >= 0 };
    })
    // Exact patterns first, then the longest prefix (TypeScript's order).
    .sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.prefix.length - a.prefix.length);
  const aliasBase = input.paths?.base ?? "";

  const fromAlias = (spec: string): string | undefined => {
    for (const a of aliases) {
      let captured: string;
      if (!a.wildcard) {
        if (spec !== a.pattern) continue;
        captured = "";
      } else {
        if (!spec.startsWith(a.prefix) || !spec.endsWith(a.suffix) || spec.length < a.prefix.length + a.suffix.length) continue;
        captured = spec.slice(a.prefix.length, spec.length - a.suffix.length);
      }
      for (const target of a.targets) {
        const hit = tryPath(resolve(aliasBase, target.replace("*", captured)));
        if (hit) return hit;
      }
    }
    return undefined;
  };

  const packages = [...input.packages].sort((a, b) => b.name.length - a.name.length);
  const fromPackage = (spec: string): string | undefined => {
    const pkg = packages.find((p) => spec === p.name || spec.startsWith(`${p.name}/`));
    if (!pkg) return undefined;
    const sub = spec === pkg.name ? "." : `./${spec.slice(pkg.name.length + 1)}`;
    const candidates: string[] = [...(pkg.exports[sub] ?? [])];
    for (const [key, targets] of Object.entries(pkg.exports)) {
      const star = key.indexOf("*");
      if (star < 0 || !sub.startsWith(key.slice(0, star)) || !sub.endsWith(key.slice(star + 1))) continue;
      const captured = sub.slice(star, sub.length - (key.length - star - 1));
      candidates.push(...targets.map((t) => t.replace("*", captured)));
    }
    if (sub !== ".") candidates.push(resolve(pkg.dir, sub), resolve(pkg.dir, "src", sub));
    for (const c of candidates) {
      const hit = tryPath(c);
      if (hit) return hit;
    }
    return undefined;
  };

  return (spec, fromFile) => {
    if (spec.startsWith(".") || spec.startsWith("/")) return tryPath(resolve(dirname(fromFile), spec));
    return fromAlias(spec) ?? fromPackage(spec);
  };
}

export interface Importer {
  file: string;
  reexport: boolean;
  line: number;
}

export interface ImporterIndex {
  /** Files scanned / candidate files. */
  scanned: number;
  total: number;
  /** The scan stopped at the file or time cap: importers among the unscanned files are missing. */
  partial: boolean;
  importersOf(file: string): readonly Importer[];
}

export interface IndexOptions {
  maxFiles?: number;
  maxMs?: number;
}

export const IMPORTER_MAX_FILES = 50_000;
export const IMPORTER_MAX_MS = 3_000;

/** Reads every candidate once (bounded) and inverts its resolved imports. */
export function buildImporterIndex(
  files: readonly string[],
  read: (abs: string) => string | undefined,
  resolveSpec: Resolve,
  options: IndexOptions = {},
): ImporterIndex {
  const maxFiles = options.maxFiles ?? IMPORTER_MAX_FILES;
  const deadline = performance.now() + (options.maxMs ?? IMPORTER_MAX_MS);
  const reverse = new Map<string, Importer[]>();
  let scanned = 0;
  let partial = false;
  for (const file of files) {
    if (scanned >= maxFiles || performance.now() > deadline) {
      partial = true;
      break;
    }
    scanned++;
    const text = read(file);
    if (text === undefined) continue;
    const seen = new Set<string>();
    for (const edge of extractImports(text)) {
      const target = resolveSpec(edge.spec, file);
      if (!target || target === file) continue;
      const key = `${target}#${edge.reexport}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = reverse.get(target) ?? [];
      list.push({ file, reexport: edge.reexport, line: edge.line });
      reverse.set(target, list);
    }
  }
  return { scanned, total: files.length, partial, importersOf: (file) => reverse.get(file) ?? [] };
}

export interface ImporterClosure {
  /** Importers (barrels included), seeds excluded, sorted. */
  importers: string[];
  /** Files that re-export a seed (or another barrel of it). */
  barrels: string[];
}

/**
 * Importers of `seeds` up to `hops` levels; a re-export (barrel) does not use a hop, so
 * importers of a barrel that re-exports a seed count as direct importers.
 */
export function importerClosure(index: ImporterIndex, seeds: readonly string[], hops: number): ImporterClosure {
  const seedSet = new Set(seeds);
  const importers = new Set<string>();
  const barrels = new Set<string>();
  let frontier = [...seeds];
  const expanded = new Set<string>(seeds);
  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const next: string[] = [];
    const queue = [...frontier];
    while (queue.length > 0) {
      const file = queue.pop()!;
      for (const imp of index.importersOf(file)) {
        if (seedSet.has(imp.file)) continue;
        importers.add(imp.file);
        if (imp.reexport) barrels.add(imp.file);
        if (expanded.has(imp.file)) continue;
        expanded.add(imp.file);
        if (imp.reexport) queue.push(imp.file);
        else next.push(imp.file);
      }
    }
    frontier = next;
  }
  return { importers: [...importers].sort(), barrels: [...barrels].sort() };
}
