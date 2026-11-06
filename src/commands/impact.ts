import { readFileSync } from "node:fs";
import { sourceFs } from "../fs.js";
import { basename, dirname, join, relative, sep } from "node:path";
import ts from "typescript";
import { bool, flag, intFlag, parseArgs, parseFields, type ParsedArgs } from "../args.js";
import type { CommandContext } from "../context.js";
import { changedRanges, parseUnifiedDiff, type FileDiff, type Range } from "../diff.js";
import { AxiError, usageError } from "../errors.js";
import { diffNameStatus, diffUnified, isGitRepo, resolveBaseRev, showFile, untrackedFiles } from "../git.js";
import {
  allocateBudget,
  classifyFile,
  compareChanges,
  formatRanges,
  inRanges,
  localOnlyLine,
  matchKey,
  reverseApply,
  wordMatches,
  type ChangeClass,
  type DeclChange,
  type FileInput,
} from "../impact.js";
import { loadProject, SOURCE_EXTENSIONS, type CallSite, type ReferenceEntry, type SemanticProject, type ViaEntry } from "../project.js";
import { block, helpBlock, out } from "../render.js";
import { isTestFile } from "../settings.js";
import { isFunctionLike, type Declaration, type Kind } from "../symbols.js";
import { IMPACT_HOPS, scopeFields, scopeHelp, semanticFor } from "../scope.js";
import { isTemplatePath, loadTemplates, templateTarget, templateUsages, usagesIn, type TemplateFile, type TemplateTarget } from "../templates.js";
import { walkFiles } from "../walk.js";
import { contextOf, lineOf, open, projectFields, type Opened } from "./common.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const SIDE_ROWS = 20;
/** Non-TS files `--grep` also searches: templates that use TS exports the checker never sees. */
const GREP_EXTRA = [".astro", ".vue", ".svelte", ".mdx", ".html"];

export const IMPACT_HELP = `usage: ts-axi impact [<git-range> | -] [flags]
input:
  (none) = working tree vs HEAD (staged + unstaged + untracked); --staged = index vs HEAD
  <git-range> = any git diff range (main...HEAD, abc123, v1..v2); - = unified diff on stdin (needs the after side checked out)
  analysis is of the current checkout - for a range whose head is not the working tree, check that head out first
flags[8]:
  --staged, --via (adds References through an interface or base member to refs[n] with a via column), --depth <1-3> (callers_depthN[n]{file,count} for N > 1), --limit <1-${MAX_LIMIT}> (default ${DEFAULT_LIMIT} ref rows across the report), --grep (adds unresolved[n]{file,line,context} - textual matches that are not References; also searches .astro/.vue/.svelte/.mdx/.html), --test-glob <glob> (repeatable), --fields <kind,exported,refs_total,via,files,tests|all> (extra changed[n] columns), -P <tsconfig>, --json
output:
  base, head, changes (count), changed[n]{symbol,change,at,refs_outside} by default; --fields adds columns in place, --fields all gives {symbol,kind,change,exported,at,refs_total,refs_outside,via,files,tests}
  change = signature | removed | type | added | body | modified (before unavailable) - riskiest first
  textual = column added only when an untyped (JavaScript; implicit project) Symbol has more whole-word matches outside the change set than refs_outside - those are uses the checker cannot resolve (declaring file only for a non-exported local); - for typed rows; such a Change is never local_only
  refs_* / files / tests count direct References only; via = References outside the change set that reach the Symbol through an interface or base member it implements (or name an override of it) - they MAY call it
  refs[n]{symbol,file,line,context} = References outside the change set; truncated + refs_shown + refs_outside_total when cut
  notes[n]{symbol,note} = a signature change of a member that implements an interface or base member (the contract may break)
  local_only = Changes with no Reference outside the change set; file_level[n]{file,lines} = changed lines outside any Declaration
  blind_spots[n]{symbol,file,line,reason} = uses the checker cannot follow (any; string keys; unresolved export *)
  templates = column added only when a changed Symbol is one templates name (directive, component, binding, controller, filter): its usages in .html/.htm/.ejs/.hbs/.njk/.pug files; - for other rows; such a Change is never local_only
  template_changes[n]{file,symbols} = templates in the diff that use a changed directive, binding, controller or filter - review them with that change
  skipped[n]{file,reason} = files in the diff that were not analysed (.astro, .json, outside the Project)
  tests: 0 on an exported signature or body change = no Test file references it (columns from --fields exported,tests)
  scope = in a monorepo without -P the program is the touched files + two levels of importers (scope_partial: true when capped)
examples[5]:
  ts-axi impact
  ts-axi impact --staged
  ts-axi impact main...HEAD
  ts-axi impact HEAD~3 --depth 2 --grep
  bb-axi pr diff 42 --raw | ts-axi impact -
`;

const SPECS = [
  { name: "--staged", boolean: true },
  { name: "--via", boolean: true },
  { name: "--depth" },
  { name: "--limit" },
  { name: "--grep", boolean: true },
  { name: "--test-glob", repeatable: true },
  { name: "--fields" },
  { name: "-P" },
];

// Opt-in columns of changed[n]; the default keeps symbol, change, at, refs_outside.
const IMPACT_FIELDS = ["kind", "exported", "refs_total", "via", "files", "tests"] as const;
const OPT_IN = new Set<string>(IMPACT_FIELDS);

interface Input {
  base: string;
  head: string;
  /** Files whose after text is read from git rather than the working tree. */
  headRev?: string;
  files: FileInput[];
  /** Diff entries without a textual diff (binary). */
  noText: string[];
  /** Files from a stdin diff that are not in the working tree. */
  missing: string[];
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw usageError("`impact -` reads a unified diff from stdin and nothing was piped", ["git diff -U0 | ts-axi impact -"]);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

// Always the working tree: it is the "after" side of the diff (impact rejects --ref).
function readText(abs: string): string | null {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** Right side of a range; undefined when git diffs it against the working tree (`abc123`). */
function headOfRange(range: string): string | undefined {
  const triple = range.indexOf("...");
  if (triple > 0) return range.slice(triple + 3) || "HEAD";
  const double = range.indexOf("..");
  if (double > 0) return range.slice(double + 2) || "HEAD";
  return undefined;
}

async function gitInput(cwd: string, root: string, range: string | undefined, staged: boolean): Promise<Input> {
  if (!(await isGitRepo(cwd))) {
    throw new AxiError("not a git repository - impact needs git or a diff on stdin", "GIT_ERROR", [
      "Run `git diff -U0 | ts-axi impact -` (or any unified diff piped to `ts-axi impact -`)",
    ]);
  }
  const [diffText, names] = await Promise.all([diffUnified(cwd, range, staged), diffNameStatus(cwd, range, staged)]);
  const parsed = parseUnifiedDiff(diffText);
  const base = staged ? "HEAD" : await resolveBaseRev(cwd, range);
  const headRev = staged ? "" : range !== undefined ? headOfRange(range) : undefined;
  const files: FileInput[] = [];
  for (const diff of parsed) {
    const { after, before } = changedRanges(diff);
    const beforeText = diff.status === "added" ? null : await showFile(cwd, base, diff.oldPath ?? diff.path);
    const afterText =
      diff.status === "deleted" ? null : headRev === undefined ? readText(join(root, diff.path)) : await showFile(cwd, headRev, diff.path);
    files.push({ path: diff.path, ...(diff.oldPath ? { oldPath: diff.oldPath } : {}), status: diff.status, after, before, afterText, beforeText });
  }
  if (range === undefined && !staged) {
    for (const path of await untrackedFiles(cwd)) {
      const text = readText(join(root, path));
      if (text === null) continue;
      const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      files.push({ path, status: "added", after: lines > 0 ? [[1, lines]] : [], before: [], afterText: text, beforeText: null });
    }
  }
  const seen = new Set(parsed.map((d) => d.path));
  return {
    base,
    head: staged ? "index" : headRev ?? "working tree",
    ...(headRev !== undefined ? { headRev } : {}),
    files,
    noText: names.filter((n) => !seen.has(n.path) && n.status !== "deleted").map((n) => n.path),
    missing: [],
  };
}

function stdinInput(text: string, root: string): Input {
  const files: FileInput[] = [];
  const missing: string[] = [];
  for (const diff of parseUnifiedDiff(text) as FileDiff[]) {
    const { after, before } = changedRanges(diff);
    const afterText = diff.status === "deleted" ? null : readText(join(root, diff.path));
    if (afterText === null && diff.status !== "deleted") {
      missing.push(diff.path);
      continue;
    }
    // The before version is the checkout with the hunks reversed; a mismatch leaves it unknown (`modified`).
    const beforeText = diff.status === "added" ? null : reverseApply(afterText ?? "", diff.hunks) ?? undefined;
    files.push({ path: diff.path, ...(diff.oldPath ? { oldPath: diff.oldPath } : {}), status: diff.status, after, before, afterText, beforeText });
  }
  return { base: "stdin diff", head: "working tree", files, noText: [], missing };
}

function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

interface Row {
  change: DeclChange;
  symbol: string;
  kind: Kind;
  exported: boolean;
  /** Working-tree Declaration (positions for queries and spans); absent for `removed`. */
  live?: Declaration;
  at: string;
  all: ReferenceEntry[];
  outside: ReferenceEntry[];
  /** Via References outside the change set. */
  via: ViaEntry[];
  /** Members the changed one implements or overrides. */
  bases: string[];
  /** Whole-word matches outside the change set, for untyped Symbols only. */
  textual?: TextualCount;
  /** Of those, lines holding no known position (what `--grep` lists for this name). */
  unresolved?: number;
  /** Template form of the Symbol and its usages (directives, components, bindings, controllers, filters). */
  template?: TemplateTarget;
  templates?: Array<{ file: string; line: number; col: number }>;
}

/** Uses of a removed Symbol in the checkout: identifiers the checker can no longer resolve. */
function brokenReferences(semantic: SemanticProject, decl: Declaration): ReferenceEntry[] {
  const checker = semantic.program.getTypeChecker();
  const result: ReferenceEntry[] = [];
  for (const file of semantic.projectFiles) {
    const sf = semantic.program.getSourceFile(file);
    if (!sf || !sf.text.includes(decl.name)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === decl.name) {
        let broken = false;
        const parent = node.parent;
        if (decl.parentName !== undefined) {
          if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node && !checker.getSymbolAtLocation(node)) {
            const owner = checker.getTypeAtLocation(parent.expression).getSymbol()?.getName();
            broken = owner === decl.parentName.split(".").pop();
          }
        } else if (!(parent && ts.isPropertyAccessExpression(parent) && parent.name === node)) {
          const symbol = checker.getSymbolAtLocation(node);
          if (!symbol) broken = !(parent && (ts.isPropertyAssignment(parent) || ts.isBindingElement(parent)) && parent.name === node);
          else if (symbol.flags & ts.SymbolFlags.Alias) broken = !(checker.getAliasedSymbol(symbol).declarations?.length);
        }
        if (broken) {
          const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          result.push({ file: semantic.index.rel(file), line: lc.line + 1, col: lc.character + 1, isDefinition: false, isWrite: false });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return result;
}

interface BlindSpot {
  symbol: string;
  file: string;
  line: number;
  reason: string;
}

const LOOSE = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

function blindSpots(semantic: SemanticProject, names: Map<string, string>, changeSet: Map<string, Range[]>): BlindSpot[] {
  const checker = semantic.program.getTypeChecker();
  const spots: BlindSpot[] = [];
  const looseName = (type: ts.Type): string => (type.flags & ts.TypeFlags.Any ? "any" : "unknown");
  for (const file of semantic.projectFiles) {
    const sf = semantic.program.getSourceFile(file);
    if (!sf) continue;
    const rel = semantic.index.rel(file);
    const hasName = [...names.keys()].some((n) => sf.text.includes(n));
    const hasBarrel = sf.text.includes("export *");
    if (!hasName && !hasBarrel) continue;
    const add = (node: ts.Node, symbol: string, reason: string): void => {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (!inRanges(changeSet.get(rel), line)) spots.push({ symbol, file: rel, line, reason });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && names.has(node.name.text)) {
        const type = checker.getTypeAtLocation(node.expression);
        if (type.flags & LOOSE) add(node, names.get(node.name.text)!, `property access on ${looseName(type)}`);
      } else if (ts.isElementAccessExpression(node)) {
        const arg = node.argumentExpression;
        let key: string | undefined;
        if (ts.isStringLiteralLike(arg)) key = arg.text;
        else {
          const argType = checker.getTypeAtLocation(arg);
          if (argType.isStringLiteral()) key = argType.value;
        }
        if (key !== undefined && names.has(key)) {
          const type = checker.getTypeAtLocation(node.expression);
          if (type.flags & LOOSE) add(node, names.get(key)!, `element access '${key}' on ${looseName(type)}`);
          else if (!checker.getPropertyOfType(checker.getApparentType(type), key)) {
            add(node, names.get(key)!, `string key '${key}' on a type without that member`);
          }
        }
      } else if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!checker.getSymbolAtLocation(node.moduleSpecifier)) add(node, "*", `export * from '${node.moduleSpecifier.text}' not resolved`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return spots;
}

function walkExtra(dir: string, outFiles: string[]): void {
  outFiles.push(...walkFiles(dir, { accept: (name) => GREP_EXTRA.some((ext) => name.endsWith(ext)) }).files);
}

export interface Unresolved {
  file: string;
  line: number;
  context: string;
}

/**
 * Whole-word matches of `names` in Project files and templates that are not `known` References;
 * a name in `localTo` (name → absolute file) is searched in that file only.
 */
export function textualMatches(
  opened: Opened,
  semantic: SemanticProject,
  names: Needle[],
  known: Set<string>,
  skipLines: Set<string>,
  changeSet: Map<string, Range[]>,
  localTo: Map<string, string> = new Map(),
): Unresolved[] {
  const files = [...semantic.projectFiles];
  const projectSet = new Set(files);
  walkExtra(opened.root, files);
  sourceFs().prefetch(files);
  const rows: Unresolved[] = [];
  for (const abs of files) {
    const text = opened.index.text(abs);
    if (text === undefined || !names.some((n) => text.includes(n.text))) continue;
    const rel = opened.index.rel(abs);
    // A Declaration of another Symbol with the same name is provably not a use.
    const declared = new Set(projectSet.has(abs) ? opened.index.declarations(abs).map((d) => d.nameLine) : []);
    const lines = new Set<number>();
    for (const { text: name, token } of names) {
      if (localTo.has(name) && localTo.get(name) !== abs) continue;
      for (const m of wordMatches(text, name, token)) {
        if (known.has(`${rel}:${m.line}`) || skipLines.has(`${rel}:${m.line}`) || declared.has(m.line) || inRanges(changeSet.get(rel), m.line)) continue;
        if (lines.has(m.line)) continue;
        lines.add(m.line);
        rows.push({ file: rel, line: m.line, context: contextOf(lineOf(text, m.line), m.col) });
      }
    }
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Whole-word matches of `name` in the Project files, one row per line: the fallback when no Declaration matches. */
export function textualScan(opened: Opened, name: string): Unresolved[] {
  const rows: Unresolved[] = [];
  sourceFs().prefetch(opened.index.files);
  for (const abs of opened.index.files) {
    const text = opened.index.text(abs);
    if (text === undefined || !text.includes(name)) continue;
    let last = 0;
    for (const m of wordMatches(text, name)) {
      if (m.line === last) continue;
      last = m.line;
      rows.push({ file: opened.index.rel(abs), line: m.line, context: contextOf(lineOf(text, m.line), m.col) });
    }
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function textualScanHint(label: string, matches: number): string {
  return `Run \`ts-axi refs ${label} --grep\` for ${matches} textual matches`;
}

/** Whether a whole-word count of the name says anything: not for router-called or by-name-injected members (`injected`). */
export function isTextualCandidate(decl: Declaration | undefined): boolean {
  return decl?.injected !== true;
}

/** What to search for: `token` = a dotted state name matched whole, else a bare identifier. */
export interface Needle {
  text: string;
  token: boolean;
}

/**
 * The textual needle of a Symbol: a state's full name without the `states.`/`routes.` prefix (a token, so
 * `ui-sref="a.b"` counts and `a.b.c` does not match `a.b`; none when it still holds `*`), else the last
 * segment of the qualified name.
 */
export function textualNeedle(subject: Declaration | string, kind?: string): Needle | undefined {
  const symbol = typeof subject === "string" ? subject : subject.qualifiedName;
  if ((kind ?? (typeof subject === "string" ? undefined : subject.kind)) === "state") {
    const name = symbol.replace(/^(states|routes)\./, "");
    return name.includes("*") || name === "" ? undefined : { text: name, token: true };
  }
  return { text: symbol.split(".").pop()!, token: false };
}

/** Whether `any`-typed property accesses of the name can be uses of the Symbol: same rule as `isTextualCandidate`. */
export function isBlindSpotCandidate(decl: Declaration | undefined): boolean {
  return decl?.injected !== true;
}

/** The checker may miss uses: JS declaring file, a string-registered name, or no tsconfig at all. */
export function isUntyped(opened: Opened, decl: Declaration | undefined, file: string | undefined): boolean {
  if (!isTextualCandidate(decl)) return false;
  return decl?.nameless === true || opened.index.project.implicit || (file !== undefined && /\.[mc]?jsx?$/.test(file));
}

/** A non-exported, non-member, identifier-named Declaration: only its own file can name it. */
export function isPlainLocal(decl: Declaration | undefined): decl is Declaration {
  return decl !== undefined && !decl.exported && !decl.nameless && decl.parentName === undefined;
}

export interface TextualCount {
  matches: number;
  files: number;
  /** Counted in the declaring file only (a plain local). */
  fileScoped?: true;
}

/**
 * Whole-word occurrences of `name` in Project files outside `changeSet`; lines declaring a `name` excluded.
 * With `onlyFile` (absolute), that file alone.
 */
export function textualCount(opened: Opened, needle: Needle, changeSet: Map<string, Range[]> = new Map(), onlyFile?: string): TextualCount {
  const { text: name, token } = needle;
  let matches = 0;
  let files = 0;
  const project = new Set(opened.index.files);
  // State names are also written in templates (`ui-sref`), which the Project does not list.
  const candidates = onlyFile !== undefined ? [onlyFile] : [...project];
  if (token && onlyFile === undefined) walkExtra(opened.root, candidates);
  sourceFs().prefetch(candidates);
  for (const abs of new Set(candidates)) {
    const text = opened.index.text(abs);
    if (text === undefined || !text.includes(name)) continue;
    const rel = opened.index.rel(abs);
    const declared = new Set(project.has(abs) ? opened.index.declarations(abs).filter((d) => d.name === name).map((d) => d.nameLine) : []);
    const n = wordMatches(text, name, token).filter((m) => !declared.has(m.line) && !inRanges(changeSet.get(rel), m.line)).length;
    matches += n;
    if (n > 0) files++;
  }
  return { matches, files, ...(onlyFile !== undefined ? { fileScoped: true as const } : {}) };
}

export function textualLine(count: TextualCount): string {
  return count.fileScoped ? `${count.matches} matches in this file` : `${count.matches} matches in ${count.files} files`;
}

export function textualHint(command: string, gap: number): string {
  return `Run \`${command}\` for the ${gap} textual matches the checker cannot resolve (untyped JavaScript)`;
}

/** `--grep` rows plus template usages of the templated rows, one per file:line. */
function withTemplateRows(textRows: Unresolved[], rows: Row[], files: TemplateFile[]): Unresolved[] {
  const texts = new Map(files.map((f) => [f.rel, f.text] as const));
  const seen = new Set(textRows.map((u) => `${u.file}:${u.line}`));
  const result = [...textRows];
  for (const row of rows) {
    for (const u of row.templates ?? []) {
      const key = `${u.file}:${u.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ file: u.file, line: u.line, context: contextOf(lineOf(texts.get(u.file), u.line), u.col) });
    }
  }
  return result.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function siteKey(site: CallSite): string {
  return `${site.item.file}#${site.item.selectionSpan.start}`;
}

function depthLevels(semantic: SemanticProject, rows: Row[], depth: number): Record<string, unknown> {
  const levels: Record<string, unknown> = {};
  if (depth < 2) return levels;
  let level: CallSite[] = [];
  for (const row of rows) {
    if (row.live && isFunctionLike(row.kind)) level.push(...(semantic.incomingCalls(semantic.index.abs(row.live.file), row.live.namePos) ?? []));
  }
  const visited = new Set<string>();
  for (let d = 2; d <= depth; d++) {
    const items = new Map<string, CallSite>();
    for (const site of level) if (!visited.has(siteKey(site)) && !items.has(siteKey(site))) items.set(siteKey(site), site);
    level = [];
    for (const [key, site] of items) {
      visited.add(key);
      level.push(...semantic.incomingCallsOf(site.item));
    }
    const counts = new Map<string, number>();
    for (const site of level) counts.set(site.file, (counts.get(site.file) ?? 0) + 1);
    const agg = [...counts.entries()].map(([file, count]) => ({ file, count })).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
    levels[`callers_depth${d}`] = agg.length === 0 ? 0 : agg.slice(0, SIDE_ROWS);
    if (agg.length > SIDE_ROWS) levels[`callers_depth${d}_total`] = agg.length;
    if (level.length === 0) break;
  }
  return levels;
}

function capped<T>(key: string, rows: T[]): Record<string, unknown> {
  return {
    [key]: rows.length === 0 ? 0 : rows.slice(0, SIDE_ROWS),
    ...(rows.length > SIDE_ROWS ? { [`${key}_total`]: rows.length } : {}),
  };
}

/** Quotes a value for a pasteable command. */
function shellWord(value: string): string {
  return /^[\w@%+=:,.\/-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/** The same `impact` invocation with every given flag replayed, the one `extra` sets replaced by it. */
function rerun(arg: string | undefined, parsed: ParsedArgs, extra: string): string {
  const parts = ["ts-axi impact"];
  if (arg !== undefined) parts.push(shellWord(arg));
  const replaced = extra.split(" ")[0];
  for (const spec of SPECS) {
    if (spec.name === replaced) continue;
    if ("boolean" in spec) {
      if (bool(parsed, spec.name)) parts.push(spec.name);
    } else if (spec.name === "--fields") {
      const fields = parseFields(flag(parsed, "--fields"), IMPACT_FIELDS);
      if (fields.length > 0) parts.push(`--fields ${fields.length === IMPACT_FIELDS.length ? "all" : fields.join(",")}`);
    } else {
      for (const value of parsed.values.get(spec.name) ?? []) parts.push(`${spec.name} ${shellWord(value)}`);
    }
  }
  parts.push(extra);
  return `${arg === "-" ? "<diff> | " : ""}${parts.join(" ")}`;
}

/**
 * Spec files skipped as "not in the Project" (a tsconfig.lib.json / tsconfig.app.json that excludes
 * them): name the sibling tsconfig that includes them so tests get counted.
 */
function specFilesHint(cwd: string, opened: Opened, skipped: Array<{ file: string; reason: string }>, noTests: boolean): string | undefined {
  const tsconfig = opened.index.project.tsconfig;
  if (!tsconfig) return undefined;
  const outside = skipped.filter((s) => s.reason === "not in the Project");
  const tests = outside.filter((s) => isTestFile(s.file, opened.settings));
  if (tests.length === 0 || !(tests.length === outside.length || noTests)) return undefined;
  const dir = dirname(tsconfig);
  const name = basename(tsconfig);
  const order = name === "tsconfig.lib.json" || name === "tsconfig.app.json" ? ["tsconfig.json", "tsconfig.spec.json"] : ["tsconfig.spec.json", "tsconfig.json"];
  const candidates = order.map((n) => join(dir, n)).filter((c) => c !== tsconfig && sourceFs().exists(c));
  // Prefer the one that really includes a skipped spec file (an Nx tsconfig.json may only hold references).
  const includes = (c: string): boolean => {
    try {
      const files = new Set(loadProject(opened.root, { path: c, implicit: false }).fileNames);
      return tests.some((t) => files.has(opened.index.abs(t.file)));
    } catch {
      return false;
    }
  };
  const pick = candidates.find(includes) ?? candidates[0];
  const rel = (abs: string): string => relative(cwd, abs).split(sep).join("/");
  return `Spec files are outside ${rel(tsconfig)}; run with -P ${pick ? rel(pick) : "<sibling tsconfig.json that includes them>"} to count tests`;
}

export async function impactCommand(args: string[], ctx: CommandContext): Promise<string> {
  const parsed = parseArgs(args, SPECS, "ts-axi impact");
  if (parsed.positionals.length > 1) {
    throw usageError(`unexpected argument '${parsed.positionals[1]}'`, ["usage: ts-axi impact [<git-range> | -] - one range like main...HEAD"]);
  }
  const arg = parsed.positionals[0];
  const staged = bool(parsed, "--staged");
  if (staged && arg !== undefined) throw usageError("--staged cannot be combined with a range or -", ["Run `ts-axi impact --staged` alone"]);
  const extras = new Set<string>(parseFields(flag(parsed, "--fields"), IMPACT_FIELDS));
  const limit = intFlag(parsed, "--limit", DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT });
  const depth = intFlag(parsed, "--depth", 1, { min: 1, max: 3 });
  const grep = bool(parsed, "--grep");
  const showVia = bool(parsed, "--via");
  const started = performance.now();

  const opened = open(ctx.cwd, parsed);
  const input =
    arg === "-"
      ? stdinInput(ctx.stdin ?? (await readStdin()), opened.root)
      : await gitInput(ctx.cwd, opened.root, arg, staged);

  // --- Which files are analysed ---
  const projectFiles = new Set(opened.index.files);
  const skipped: Array<{ file: string; reason: string }> = [
    ...input.noText.map((file) => ({ file, reason: "binary or no textual diff" })),
    ...input.missing.map((file) => ({ file, reason: "not in the working tree" })),
  ];
  const analysed: FileInput[] = [];
  // Templates stay skipped unless they use a changed Symbol (then template_changes).
  const templateInputs: FileInput[] = [];
  for (const file of input.files) {
    if (/\.d\.[mc]?ts$/.test(file.path)) skipped.push({ file: file.path, reason: "declaration file" });
    else if (isTemplatePath(file.path)) templateInputs.push(file);
    else if (!isSourcePath(file.path)) skipped.push({ file: file.path, reason: "not TS or JS source" });
    else if (file.status !== "deleted" && !projectFiles.has(opened.index.abs(file.path))) skipped.push({ file: file.path, reason: "not in the Project" });
    else analysed.push(file);
  }

  const warnings = opened.warning ? [opened.warning] : [];
  if (input.headRev !== undefined) {
    const differ = analysed.filter((f) => f.afterText !== null && f.afterText !== opened.index.text(opened.index.abs(f.path))).length;
    if (differ > 0) warnings.push(`${differ} touched files differ between ${input.head} and the working tree - refs come from the working tree`);
  }

  // --- Classification (syntactic) ---
  const declChanges: DeclChange[] = [];
  const fileLevel: Array<{ file: string; lines: string }> = [];
  const changeSet = new Map<string, Range[]>();
  for (const file of analysed) {
    const result = classifyFile(file);
    declChanges.push(...result.changes);
    if (file.after.length > 0) changeSet.set(file.path, [...file.after]);
    if (result.fileLevel) {
      const lines = result.fileLevel.after.length > 0 ? formatRanges(result.fileLevel.after) : `before ${formatRanges(result.fileLevel.before)}`;
      fileLevel.push({ file: file.path, lines });
    } else if (file.status === "renamed" && file.after.length === 0 && file.before.length === 0) {
      fileLevel.push({ file: file.path, lines: `renamed from ${file.oldPath ?? "?"}` });
    }
  }
  const total = declChanges.length + fileLevel.length;
  const header = {
    ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
    ...projectFields(opened),
    base: input.base,
    head: input.head,
    changes: total,
  };
  const skipTemplates = (used: Set<string>): void => {
    for (const f of templateInputs) if (!used.has(f.path)) skipped.push({ file: f.path, reason: "not TS or JS source" });
  };

  if (declChanges.length === 0) {
    skipTemplates(new Set());
    const skippedBlock = skipped.length > 0 ? capped("skipped", skipped) : {};
    const help = total === 0
      ? [arg === undefined && !staged ? "Run `ts-axi impact main...HEAD` to analyse a branch against main" : "Run `ts-axi impact` for uncommitted changes"]
      : ["Changes touch imports or module-level statements only - read those lines directly"];
    if (skipped.length > 0) help.push("Skipped files are not TS or JS source of the Project - review them by hand");
    const specHint = specFilesHint(ctx.cwd, opened, skipped, true);
    if (specHint) help.push(specHint);
    return out(
      block({
        ...header,
        ...(fileLevel.length > 0 ? { file_level: fileLevel } : {}),
        ...skippedBlock,
        elapsed_ms: Math.round(performance.now() - started),
      }),
      helpBlock(help),
    );
  }

  // --- References (semantic, on the checkout) ---
  // Scoped workspace: touched files + two levels of importers; deleted or renamed-away paths still resolve so their importers count.
  const { semantic, scope } = semanticFor(
    opened,
    analysed.filter((f) => f.status !== "deleted").map((f) => opened.index.abs(f.path)),
    IMPACT_HOPS,
    analysed.flatMap((f) => (f.status === "deleted" ? [f.path] : f.oldPath ? [f.oldPath] : [])).map((p) => opened.index.abs(p)),
  );
  const rows: Row[] = declChanges.map((change) => {
    const source = change.after ?? change.before!;
    const live = change.after ? opened.index.declarations(opened.index.abs(change.file)).find((d) => matchKey(d) === change.key) : undefined;
    return {
      change,
      symbol: source.qualifiedName,
      kind: source.kind,
      exported: source.exported,
      ...(live ? { live } : {}),
      at: `${change.file}:${(live ?? source).nameLine}`,
      all: [],
      outside: [],
      via: [],
      bases: [],
    };
  });
  for (const row of rows) {
    if (row.live) changeSet.set(row.change.file, [...(changeSet.get(row.change.file) ?? []), [row.live.line, row.live.endLine]]);
  }
  const known = new Set<string>();
  const byPosition = (a: ReferenceEntry, b: ReferenceEntry): number => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col;
  for (const row of rows) {
    let entries: ReferenceEntry[] = [];
    if (row.live) {
      const split = semantic.referenceSplit(opened.index.abs(row.live.file), row.live.namePos);
      entries = [...split.declarations, ...split.direct];
      // Sibling implementations and via uses are known positions, not textual misses for --grep.
      for (const e of [...split.via, ...split.implementations, ...split.dropped]) known.add(`${e.file}:${e.line}`);
      row.via = split.via.filter((e) => !inRanges(changeSet.get(e.file), e.line)).sort(byPosition);
      row.bases = split.bases;
    } else if (row.change.change === "removed") {
      entries = brokenReferences(semantic, row.change.before!);
    }
    for (const e of entries) known.add(`${e.file}:${e.line}`);
    row.all = entries.filter((e) => !e.isDefinition);
    row.outside = row.all.filter((e) => !inRanges(changeSet.get(e.file), e.line)).sort(byPosition);
  }
  for (const row of rows) {
    if (!row.live || !isUntyped(opened, row.live, row.live.file)) continue;
    const localTo = isPlainLocal(row.live) ? new Map([[row.live.name, opened.index.abs(row.live.file)]]) : undefined;
    const needle = textualNeedle(row.live);
    if (!needle) continue;
    row.textual = textualCount(opened, needle, changeSet, localTo?.get(row.live.name));
    if (row.textual.matches > 0) row.unresolved = textualMatches(opened, semantic, [needle], known, new Set(), changeSet, localTo).length;
  }
  // Template usages: directives, components, bindings, controllers and filters named in .html and friends.
  let templateFiles: TemplateFile[] | undefined;
  for (const row of rows) {
    const decl = row.live ?? row.change.before!;
    const fileDecls = [
      ...opened.index.declarations(opened.index.abs(row.change.file)),
      ...declChanges.filter((c) => c.file === row.change.file).flatMap((c) => (c.before ? [c.before] : [])),
    ];
    const target = templateTarget(decl, fileDecls);
    if (!target) continue;
    templateFiles ??= loadTemplates(opened.root);
    row.template = target;
    row.templates = templateUsages(templateFiles, target);
  }
  const templateChanges: Array<{ file: string; symbols: string }> = [];
  for (const f of templateInputs) {
    const text = f.afterText ?? f.beforeText;
    if (typeof text !== "string") continue;
    const symbols = [...new Set(rows.filter((r) => r.template && usagesIn(text, r.template).length > 0).map((r) => r.symbol))];
    if (symbols.length > 0) templateChanges.push({ file: f.path, symbols: symbols.join("; ") });
  }
  skipTemplates(new Set(templateChanges.map((t) => t.file)));
  const skippedBlock = skipped.length > 0 ? capped("skipped", skipped) : {};

  // Textual matches the checker did not resolve: such a Change is never local_only.
  const textualGap = (r: Row): number => (r.textual && r.textual.matches > r.outside.length ? r.unresolved ?? 0 : 0);
  const shownRefs = (r: Row): Array<ReferenceEntry & { via?: string }> => (showVia ? [...r.outside, ...r.via].sort(byPosition) : r.outside);
  const hasOutside = (r: Row): boolean => r.outside.length > 0 || r.via.length > 0 || textualGap(r) > 0 || (r.templates?.length ?? 0) > 0;

  const listed = rows
    .filter(hasOutside)
    .sort((a, b) =>
      compareChanges(
        { change: a.change.change, exported: a.exported, refsOutside: a.outside.length, file: a.change.file, line: (a.live ?? a.change.before!).line },
        { change: b.change.change, exported: b.exported, refsOutside: b.outside.length, file: b.change.file, line: (b.live ?? b.change.before!).line },
      ),
    );
  const localOnly = rows
    .filter((r) => !hasOutside(r))
    .sort((a, b) => compareChanges(
      { change: a.change.change, exported: a.exported, refsOutside: 0, file: a.change.file, line: (a.live ?? a.change.before!).line },
      { change: b.change.change, exported: b.exported, refsOutside: 0, file: b.change.file, line: (b.live ?? b.change.before!).line },
    ));

  const quotas = allocateBudget(listed.map((r) => shownRefs(r).length), limit);
  const refRows = listed.flatMap((r, i) =>
    shownRefs(r).slice(0, quotas[i]).map((e) => ({
      symbol: r.symbol,
      file: e.file,
      line: e.line,
      ...(showVia ? { via: e.via ?? "-" } : {}),
      context: contextOf(lineOf(opened.index.text(opened.index.abs(e.file)), e.line), e.col),
    })),
  );
  const outsideTotal = listed.reduce((n, r) => n + shownRefs(r).length, 0);
  const truncated = refRows.length < outsideTotal;

  const fileCounts = (r: Row): { files: number; tests: number } => {
    const files = [...new Set(r.outside.map((e) => e.file))];
    return { files: files.length, tests: files.filter((f) => isTestFile(f, opened.settings)).length };
  };

  // --- Blind spots, textual matches, deeper callers ---
  const names = new Map<string, string>();
  const textNames = new Map<string, Needle>();
  // A name is file-scoped only when every changed Declaration carrying it is a plain local of one file.
  const localTo = new Map<string, string>();
  const wide = new Set<string>();
  for (const r of rows) {
    const decl = r.change.after ?? r.change.before!;
    const name = decl.name;
    if (isBlindSpotCandidate(decl) && !names.has(name)) names.set(name, r.symbol);
    const needle = isTextualCandidate(decl) ? textualNeedle(decl) : undefined;
    if (!needle) continue;
    if (!textNames.has(needle.text)) textNames.set(needle.text, needle);
    const abs = opened.index.abs(decl.file);
    if (!isPlainLocal(decl) || (localTo.has(name) && localTo.get(name) !== abs)) wide.add(name);
    else localTo.set(name, abs);
  }
  for (const name of wide) localTo.delete(name);
  const spots = blindSpots(semantic, names, changeSet);
  const textRows = grep
    ? textualMatches(opened, semantic, [...textNames.values()], known, new Set(spots.map((s) => `${s.file}:${s.line}`)), changeSet, localTo)
    : [];
  const unresolved = grep ? withTemplateRows(textRows, rows, templateFiles ?? []) : [];

  const touched = [...new Set([...analysed.filter((f) => f.status !== "deleted").map((f) => f.path), ...listed.flatMap((r) => r.outside.map((e) => e.file))])];
  const diagnostics = semantic.diagnosticsCount(touched);

  // --- Help ---
  const help: string[] = [];
  const top = listed.find((r) => r.live) ?? localOnly.find((r) => r.live);
  if (top) {
    help.push(`Run \`ts-axi refs ${top.at}\` for every Reference of ${top.symbol}`);
    if (isFunctionLike(top.kind)) help.push(`Run \`ts-axi callers ${top.at}\` for its call sites with the enclosing function`);
    help.push(`Run \`ts-axi def ${top.at}\` for the changed declaration`);
  }
  if (listed.length > 0 && extras.size === 0) help.push(`Run \`${rerun(arg, parsed, "--fields files,tests")}\` for how many files and Test files reference each Symbol`);
  const removedTop = listed.find((r) => r.change.change === "removed");
  if (removedTop) help.push(`${removedTop.symbol} was removed but is still referenced - those files break`);
  if (truncated) help.push(`Showing ${refRows.length} of ${outsideTotal} ref rows; run \`${rerun(arg, parsed, `--limit ${Math.min(MAX_LIMIT, outsideTotal)}`)}\` for more`);
  const gap = listed.reduce((n, r) => n + textualGap(r), 0);
  if (gap > 0 && !grep) help.unshift(textualHint(rerun(arg, parsed, "--grep"), gap));
  if (spots.length > 0 && !grep && gap === 0) help.push(`Run \`${rerun(arg, parsed, "--grep")}\` for textual matches the checker cannot see`);
  if (depth === 1 && rows.some((r) => r.live && isFunctionLike(r.kind) && r.outside.length > 0)) {
    help.push(`Run \`${rerun(arg, parsed, "--depth 2")}\` for who calls the callers`);
  }
  if (!showVia && listed.some((r) => r.via.length > 0)) {
    help.push(`Run \`${rerun(arg, parsed, "--via")}\` for References through an interface or base member - they may reach the changed code`);
  }
  const templated = listed.filter((r) => (r.templates?.length ?? 0) > 0).sort((a, b) => b.templates!.length - a.templates!.length)[0];
  if (templated && !grep) help.push(`Run \`ts-axi refs ${templated.at} --grep\` for the ${templated.templates!.length} template usages of ${templated.symbol}`);
  if (templateChanges.length > 0) help.push("template_changes use a changed directive or binding - review each against that change");
  if (skipped.length > 0) help.push("Skipped files are not TS or JS source of the Project - review them by hand");
  const specHint = specFilesHint(ctx.cwd, opened, skipped, listed.every((r) => fileCounts(r).tests === 0));
  if (specHint) help.push(specHint);
  help.push(...scopeHelp(scope));
  const notes = rows
    .filter((r) => r.change.change === "signature" && r.bases.length > 0)
    .map((r) => ({ symbol: r.symbol, note: `implements ${r.bases.join(" and ")}` }));

  return out(
    block({
      ...header,
      ...(listed.length > 0
        ? {
            changed: listed.map((r) => {
              // Built in the full column order, then cut to the default plus --fields, so --fields all matches the old output.
              const full: Record<string, unknown> = {
                symbol: r.symbol,
                kind: r.kind,
                change: r.change.change satisfies ChangeClass,
                exported: r.exported,
                at: r.at,
                refs_total: r.all.length,
                refs_outside: r.outside.length,
                via: r.via.length,
                ...(gap > 0 ? { textual: r.textual ? r.textual.matches : "-" } : {}),
                ...(rows.some((x) => x.template) ? { templates: r.templates ? r.templates.length : "-" } : {}),
                ...fileCounts(r),
              };
              return Object.fromEntries(Object.entries(full).filter(([k]) => !OPT_IN.has(k) || extras.has(k)));
            }),
            ...(refRows.length > 0 ? { refs: refRows } : {}),
          }
        : {}),
      ...(truncated ? { truncated: true, refs_shown: refRows.length, refs_outside_total: outsideTotal } : {}),
      ...(notes.length > 0 ? { notes } : {}),
      ...(localOnly.length > 0 ? { local_only: localOnlyLine(localOnly.map((r) => `${r.symbol} ${r.change.change}`)) } : {}),
      ...(fileLevel.length > 0 ? { file_level: fileLevel } : {}),
      ...(templateChanges.length > 0 ? capped("template_changes", templateChanges) : {}),
      ...capped("blind_spots", spots),
      ...(grep ? capped("unresolved", unresolved) : {}),
      ...depthLevels(semantic, rows, depth),
      ...skippedBlock,
      ...scopeFields(scope),
      elapsed_ms: Math.round(performance.now() - started),
      ...(diagnostics > 0 ? { diagnostics } : {}),
    }),
    helpBlock(help),
  );
}
