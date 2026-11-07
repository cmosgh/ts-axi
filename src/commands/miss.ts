// The miss fallback: when a name target matches no indexed Declaration, look for it syntactically in
// source files the tsconfig leaves out and in function-local Declarations, so a miss is never silent.
import { dirname, join, posix, relative, sep } from "node:path";
import ts from "typescript";
import { sourceFs } from "../fs.js";
import { matchesGlob } from "../glob.js";
import { declMatches, isSourceFile, nearestTsconfig } from "../project.js";
import type { Declaration, Target } from "../symbols.js";
import { byDepthThenPath, listFiles } from "../walk.js";
import { declarationAt, type Opened, type TargetFilters } from "./common.js";

/** At most this many files that pass the name prefilter are parsed; the rest are counted in `not_searched`. */
export const MISS_PARSE_CAP = 2_000;

export interface LocalDecl {
  /** Offset of the name identifier. */
  pos: number;
  name: string;
  /** Enclosing function or member (`Comp`, `User.save`); `(top-level block)` outside any function. */
  owner: string;
}

const ANON = "(anonymous)";

function nameOf(node: ts.Node | undefined): string | undefined {
  return node && (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined;
}

/** Name of a function-like node: its own, or the variable / property / member it is assigned to. */
function functionName(fn: ts.SignatureDeclaration): string | undefined {
  const parent = fn.parent;
  const cls = parent && (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) ? nameOf(parent.name) ?? ANON : undefined;
  if (ts.isConstructorDeclaration(fn)) return `${cls ?? ANON}.constructor`;
  const own = nameOf(fn.name);
  if (own !== undefined) return cls !== undefined ? `${cls}.${own}` : own;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) return nameOf(parent.name);
  if (ts.isPropertyDeclaration(parent)) {
    const owner = parent.parent as ts.ClassLikeDeclaration;
    return `${nameOf(owner.name) ?? ANON}.${nameOf(parent.name) ?? ANON}`;
  }
  return undefined;
}

/** Nearest named enclosing function; anonymous callbacks (`useEffect(() => ...)`) are skipped. */
function ownerOf(node: ts.Node): string {
  for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isFunctionLike(n)) {
      const name = functionName(n);
      if (name !== undefined) return name;
    }
  }
  return "(top-level block)";
}

/**
 * Function, class and plain `const/let/var x` Declarations named `name` that sit in a function or block
 * body (not top level, not a namespace). Parameters, destructured and loop bindings are left out.
 */
export function findLocals(sf: ts.SourceFile, name: string): LocalDecl[] {
  const found: LocalDecl[] = [];
  const nested = (statement: ts.Node): boolean => !ts.isSourceFile(statement.parent) && !ts.isModuleBlock(statement.parent);
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name && nested(node)) {
      found.push({ pos: node.name.getStart(sf), name, owner: ownerOf(node) });
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      ts.isVariableStatement(node.parent.parent) &&
      nested(node.parent.parent)
    ) {
      found.push({ pos: node.name.getStart(sf), name, owner: ownerOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

export interface MissHit {
  decl: Declaration;
  abs: string;
  /** `file:line:col` of the name: the position target that resolves to exactly this Declaration. */
  at: string;
  /** Enclosing function of a local Declaration. */
  localTo?: string;
  /** Why the file is not in the Project (`outside (Deno edge/deno.json)`). */
  outside?: string;
}

export interface MissResult {
  hits: MissHit[];
  /** Candidate files past `MISS_PARSE_CAP`, not parsed. */
  skipped: number;
  /** The fs walk (no git) stopped at its bound: left-out files past it were never listed. */
  walkCapped: boolean;
}

const outsideCache = new WeakMap<Opened, { files: string[]; set: Set<string>; capped: boolean }>();

/**
 * Source files below the repo root the Project does not list (gitignored, node_modules and `.d.ts`
 * dropped). Empty for a workspace or implicit Project: those already list every source file.
 */
export function outsideFiles(opened: Opened): string[] {
  const cached = outsideCache.get(opened);
  if (cached) return cached.files;
  const { project } = opened.index;
  let files: string[] = [];
  let capped = false;
  if (!project.scope && !project.implicit) {
    const known = new Set(opened.index.files);
    // node_modules and build dirs are already dropped by the shared skip rule.
    const listing = listFiles(opened.root, isSourceFile, { maxFiles: 20_000, deadline: Date.now() + 600 });
    files = listing.files.filter((f) => !known.has(f));
    capped = listing.capped;
  }
  outsideCache.set(opened, { files, set: new Set(files), capped });
  return files;
}

const projectSets = new WeakMap<Opened, Set<string>>();

/** Lists the left-out files only for a file the Project does not hold, so hit paths stay listing-free. */
export function isOutside(opened: Opened, abs: string): boolean {
  let known = projectSets.get(opened);
  if (!known) projectSets.set(opened, (known = new Set(opened.index.files)));
  if (known.has(abs)) return false;
  outsideFiles(opened);
  return outsideCache.get(opened)!.set.has(abs);
}

/** `outside (Deno edge/deno.json)`, `outside (own tsconfig x/tsconfig.json)` or `outside (not in tsconfig.json)`. */
export function outsideReason(opened: Opened, abs: string): string {
  const root = opened.root;
  for (let dir = dirname(abs); ; dir = dirname(dir)) {
    for (const name of ["deno.json", "deno.jsonc"]) {
      if (sourceFs().exists(join(dir, name))) return `outside (Deno ${opened.index.rel(join(dir, name))})`;
    }
    if (dir === root || dirname(dir) === dir) break;
  }
  const own = nearestTsconfig(abs, root);
  const projectTsconfig = opened.index.project.tsconfig;
  if (own && own !== projectTsconfig) return `outside (own tsconfig ${opened.index.rel(own)})`;
  return projectTsconfig ? `outside (not in ${relative(opened.cwd, projectTsconfig).split(sep).join("/")})` : "outside (not in the Project)";
}

/** `--in` globs are cwd-relative; files are root-relative. */
function rootGlobs(opened: Opened, globs: readonly string[]): string[] {
  const prefix = relative(opened.root, opened.cwd).split(sep).join("/");
  return globs.map((g) => {
    const clean = g.replace(/^\.\//, "");
    return prefix && !prefix.startsWith("..") ? posix.join(prefix, clean) : clean;
  });
}

function inGlobs(rel: string, globs: readonly string[]): boolean {
  return globs.length === 0 || globs.some((g) => matchesGlob(rel, g));
}

function nameCol(sf: ts.SourceFile, pos: number): { line: number; col: number } {
  const lc = sf.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, col: lc.character + 1 };
}

/** Declarations of the name outside the Project, plus function-local ones anywhere (see the header). */
export function missFallback(opened: Opened, target: Extract<Target, { kind: "name" }>, f: TargetFilters): MissResult {
  if (f.fuzzy) return { hits: [], skipped: 0, walkCapped: false };
  const { index } = opened;
  const globs = rootGlobs(opened, f.in);
  const outside = outsideFiles(opened);
  const word = target.member ?? target.name;
  const pick = (list: readonly string[]): readonly string[] => (globs.length === 0 ? list : list.filter((abs) => inGlobs(index.rel(abs), globs)));
  const outsidePicked = pick(outside);
  const candidates = [...pick(index.files), ...outsidePicked];
  sourceFs().prefetch(outsidePicked);
  const hits: MissHit[] = [];
  let parsed = 0;
  let skipped = 0;
  for (const abs of candidates) {
    const text = index.text(abs);
    if (text === undefined || !text.includes(word)) continue;
    if (++parsed > MISS_PARSE_CAP) {
      skipped++;
      continue;
    }
    const sf = index.sourceFile(abs);
    if (!sf) continue;
    const reason = isOutside(opened, abs) ? outsideReason(opened, abs) : undefined;
    const add = (decl: Declaration, localTo?: string): void => {
      if (f.kind !== undefined && decl.kind !== f.kind) return;
      if (f.exported && !decl.exported) return;
      const { line, col } = nameCol(sf, decl.namePos);
      hits.push({ decl, abs, at: `${decl.file}:${line}:${col}`, ...(localTo !== undefined ? { localTo } : {}), ...(reason ? { outside: reason } : {}) });
    };
    const indexed = index.declarations(abs);
    if (reason) for (const d of indexed) if (declMatches(d, { name: target.name, ...(target.member !== undefined ? { member: target.member } : {}) })) add(d);
    if (target.member !== undefined) continue;
    const known = new Set(indexed.map((d) => d.namePos));
    for (const local of findLocals(sf, target.name)) {
      if (known.has(local.pos)) continue;
      const decl = declarationAt(index, abs, local.pos, "variable");
      if (decl) add(decl, local.owner);
    }
  }
  hits.sort((a, b) => byDepthThenPath(a.decl.file, b.decl.file) || a.decl.namePos - b.decl.namePos);
  return { hits, skipped, walkCapped: outsideCache.get(opened)!.capped };
}

/** `local to Comp`, `outside (...)` or both: the `where` cell and the single-hit fields. */
export function whereOf(hit: MissHit): string {
  return [hit.localTo !== undefined ? `local to ${hit.localTo}` : undefined, hit.outside].filter(Boolean).join("; ");
}

/** Fields a single fallback hit adds to a detail or refs header. */
export function missFields(hit: MissHit): Record<string, unknown> {
  return { ...(hit.localTo !== undefined ? { local_to: hit.localTo } : {}), ...(hit.outside ? { project: hit.outside } : {}) };
}

/** `matches[n]{at,kind,name,where}` for several fallback hits. */
export function missRows(result: MissResult, max: number): Record<string, unknown> {
  const rows = result.hits.slice(0, max).map((h) => ({ at: h.at, kind: h.decl.kind, name: h.decl.qualifiedName, where: whereOf(h) }));
  return {
    matches: rows,
    ...(result.hits.length > max ? { matches_total: result.hits.length, truncated: true } : {}),
    ...notSearched(result),
  };
}

/** `not_searched` when a bound stopped the fallback. */
export function notSearched(result: MissResult): Record<string, unknown> {
  const parts = [
    ...(result.skipped > 0 ? [`${result.skipped} files past the ${MISS_PARSE_CAP}-file cap`] : []),
    ...(result.walkCapped ? ["files past the 20000-file or 0.6 s walk bound (no git)"] : []),
  ];
  return parts.length > 0 ? { not_searched: parts.join("; ") } : {};
}

/** Outside-Project source files whose text holds `name`: extra roots so a semantic run sees their uses. */
export function outsideSeeds(opened: Opened, name: string): string[] {
  return outsideFiles(opened).filter((abs) => opened.index.text(abs)?.includes(name));
}

/** `3 matches in 2 files (edge/fn; tools)`: textual rows from outside-Project files, at most 3 dirs. */
export function outsideLine(opened: Opened, rows: ReadonlyArray<{ file: string }>): string | undefined {
  const outside = new Set(outsideFiles(opened).map((abs) => opened.index.rel(abs)));
  const mine = rows.filter((r) => outside.has(r.file));
  if (mine.length === 0) return undefined;
  const files = [...new Set(mine.map((r) => r.file))];
  const dirs = [...new Set(files.map((f) => posix.dirname(f)))];
  const shown = dirs.slice(0, 3).join("; ") + (dirs.length > 3 ? `; +${dirs.length - 3} more` : "");
  return `${mine.length} matches in ${files.length} files (${shown})`;
}
