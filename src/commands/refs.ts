import { relative, sep } from "node:path";
import { bool, expectPositionals, flag, intFlag, parseArgs } from "../args.js";
import type { CommandContext } from "../context.js";
import { importerClosure } from "../importers.js";
import { isPlainLocal, isTextualCandidate, isUntyped, textualCount, textualNeedle, textualHint, textualLine, textualMatches, textualScan, textualScanHint, type TextualCount, type Unresolved } from "./impact.js";
import { findOutsideProject, nearestTsconfig, type CallSite, type SemanticProject } from "../project.js";
import { viaLine } from "../references.js";
import { block, helpBlock, out } from "../render.js";
import { importerIndexFor, REFS_HOPS, scopeFields, scopeHelp, semanticFor, type ScopeInfo } from "../scope.js";
import { loadTemplates, templatesLine, templateTarget, templateUsages } from "../templates.js";
import { byDepthThenPath } from "../walk.js";
import { detectWorkspace, isMultiProject } from "../workspace.js";
import { isTestFile } from "../settings.js";
import { isFunctionLike, kindFromScriptElement, parseTarget, registrationOf, type Declaration, type Kind } from "../symbols.js";
import {
  contextOf,
  declarationAt,
  filterSuffix,
  lineOf,
  MATCH_ROWS,
  matchRows,
  narrowHints,
  open,
  positionStartDir,
  projectFields,
  readFilters,
  useRef,
  resolveNameTarget,
  resolvePosition,
  suggestions,
  TARGET_FLAGS,
  targetLabel,
  type Opened,
} from "./common.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEPTH_ROWS = 50;

const SHARED_FLAGS = `--kind <function|class|method|property|variable|interface|type|enum|enum-member|namespace|state> (narrows a name), --in <dir|glob> (repeatable; Declarations in these files), --exported, --fuzzy, --limit <1-${MAX_LIMIT}> (default ${DEFAULT_LIMIT} rows), --test-glob <glob> (repeatable; extra Test file pattern), --via (adds via rows with a via column), -P <tsconfig>, --ref <rev> (read the code at a git revision; working tree ignored), --json`;

const VIA_DOC = `via_interface: n (Iface.member) = References through an interface or base member the Symbol implements or overrides - they MAY reach it; not in refs_total
  via_implementations: n (Impl.member) = References to implementations or overrides of the Symbol; not in refs_total
  implementations: n = members that implement or override the Symbol (their Declarations are never refs)
  matches: 0 under -P lists found_outside_project[n]{file,line} when the name is declared outside that Project
  refs_total: 0 under -P in a workspace lists found_outside_project[n]{file,line} = importers outside that Project
  scope = in a monorepo without -P the program is the declaring file + its importers (scope_partial: true when the importer scan was capped)
  tsconfig: x (n referenced configs) = a references-only tsconfig expanded to the configs it references
  textual: n matches in m files = whole-word count of the name in Project files (JavaScript declarations and implicit projects; a state counts its full dotted name as a whole token, templates included; not for a state's resolve keys and hooks - injected by name, not imported); 'n matches in this file' for a non-exported local; above refs_total = uses the checker cannot resolve - see refs --grep
  templates: n usages in m files = template uses (.html .htm .ejs .hbs .njk .pug) of a directive or component (<wap-select / wap-select / data-wap-select), its bindings (fallback-display-property= on that tag), a controller (ng-controller) or a filter (| money); refs --grep lists them in unresolved`;

export const REFS_HELP = `usage: ts-axi refs <name | Class.member | path:line[:col]> [flags]
flags[13]:
  ${SHARED_FLAGS}
  --implementations (lists implementations[n]{file,line,symbol} instead of the count)
  --grep (adds unresolved[n]{file,line,context} - textual matches of the name that are not References; also searches .astro/.vue/.svelte/.mdx/.html)
  --kind calls = same as \`ts-axi callers\`
output:
  symbol, kind, declared_at, refs_total, files, tests, refs[n]{file,line,context} (Declarations excluded), elapsed_ms
  ${VIA_DOC}
  note = the name is registered by a string ('Name' in .controller('Name', fn)) - its uses are textual; add --grep
  an ambiguous name lists matches[n] (at most ${MATCH_ROWS}; matches_total + truncated past that) + the narrowing forms; nothing is analysed
examples[4]:
  ts-axi refs User.save
  ts-axi refs src/models/user.ts:12
  ts-axi refs parse --in src/models
  ts-axi refs runSync --limit 200
`;

export const CALLERS_HELP = `usage: ts-axi callers <name | Class.member | path:line[:col]> [flags]
flags[12]:
  ${SHARED_FLAGS}
  --depth <1-3> (default 1; levels > 1 print callers_depthN[n]{caller,file,count}, no locations)
output:
  symbol, kind, declared_at, refs_total, files, tests, refs[n]{file,line,caller,context}, elapsed_ms
  caller = enclosing function or method; (top-level) for module code
  ${VIA_DOC}
examples[3]:
  ts-axi callers runSync
  ts-axi callers User.save --depth 2
  ts-axi callers src/services/sync.ts:20
`;

interface Resolved {
  absFile: string;
  pos: number;
  decl?: Declaration;
  /** Files declaring the Symbol (overloads and merged Declarations may span files). */
  seeds?: string[];
}

type Mode = "refs" | "calls";

export async function refsCommand(args: string[], ctx: CommandContext): Promise<string> {
  return run(args, ctx, "refs");
}

export async function callersCommand(args: string[], ctx: CommandContext): Promise<string> {
  return run(args, ctx, "calls");
}

async function run(args: string[], ctx: CommandContext, invoked: Mode): Promise<string> {
  const command = invoked === "calls" ? "ts-axi callers" : "ts-axi refs";
  const specs = [
    ...TARGET_FLAGS,
    { name: "--limit" },
    { name: "--test-glob", repeatable: true },
    { name: "--via", boolean: true },
    ...(invoked === "calls" ? [{ name: "--depth" }] : [{ name: "--implementations", boolean: true }, { name: "--grep", boolean: true }]),
  ];
  const parsed = parseArgs(args, specs, command);
  const [raw] = expectPositionals(parsed, 1, `${command} <name | Class.member | path:line[:col]> [flags]`);
  const f = readFilters(parsed, invoked === "refs" ? ["calls"] : []);
  const mode: Mode = f.rawKind === "calls" ? "calls" : invoked;
  const limit = intFlag(parsed, "--limit", DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT });
  const depth = invoked === "calls" ? intFlag(parsed, "--depth", 1, { min: 1, max: 3 }) : 1;
  const target = parseTarget(raw!, { fuzzy: f.fuzzy });
  const label = targetLabel(target);
  const project = flag(parsed, "-P");
  const name = mode === "calls" ? "callers" : "refs";
  const show = {
    via: bool(parsed, "--via"),
    implementations: invoked === "refs" && bool(parsed, "--implementations"),
    grep: invoked === "refs" && bool(parsed, "--grep"),
  };
  const started = performance.now();
  ctx = useRef(ctx, parsed);
  const opened = open(ctx.cwd, parsed, positionStartDir(ctx.cwd, target));
  const warning = opened.warning ? { warning: opened.warning } : {};

  // Resolve to exactly one Symbol before building a program.
  let resolved: Resolved;
  if (target.kind === "name") {
    const groups = resolveNameTarget(opened, target, f);
    if (groups.length === 0) {
      // Under an explicit Project the name may live in a sibling one: say so before suggesting --fuzzy.
      const outside = project || opened.settings.project
        ? findOutsideProject(opened.index, { name: target.name, ...(target.member !== undefined ? { member: target.member } : {}), fuzzy: f.fuzzy })
        : [];
      if (outside.length > 0) {
        const tsconfig = nearestTsconfig(opened.index.abs(outside[0]!.file), opened.root);
        const rel = tsconfig ? relative(ctx.cwd, tsconfig).split(sep).join("/") : undefined;
        return out(
          block({
            ...warning,
            matches: 0,
            found_outside_project: outside.map((d) => ({ file: d.file, line: d.nameLine })),
            hint: `symbol is declared outside the selected project - run with -P ${rel ?? "<its tsconfig>"} or without -P`,
          }),
          helpBlock([
            ...(rel ? [`Run \`ts-axi ${name} ${label} -P ${rel}\``] : []),
            `Run \`ts-axi ${name} ${outside[0]!.file}:${outside[0]!.nameLine}\` to use the nearest tsconfig of that file`,
          ]),
        );
      }
      // No Declaration, but the name may still be written: an untyped property set up elsewhere.
      const text = f.fuzzy ? [] : textualScan(opened, target.member ?? target.name);
      if (show.grep) {
        return out(
          block({
            ...warning,
            matches: 0,
            note: "no declaration found - textual matches only",
            unresolved: text.length === 0 ? 0 : text.slice(0, limit),
            ...(text.length > limit ? { unresolved_total: text.length } : {}),
          }),
          helpBlock([
            ...(text.length > limit ? [`Showing ${limit} of ${text.length}; run \`ts-axi refs ${label} --grep --limit ${Math.min(MAX_LIMIT, text.length)}\` for more`] : []),
            `Run \`ts-axi def ${label} --fuzzy\` for substring matches`,
          ]),
        );
      }
      const suggested = suggestions(opened, target);
      return out(
        block({ ...warning, matches: 0, ...(suggested.length > 0 ? { did_you_mean: suggested } : {}) }),
        helpBlock([
          ...(text.length > 0 ? [textualScanHint(label, text.length)] : []),
          ...suggested.slice(0, 2).map((s) => `Run \`ts-axi ${name} ${s}\``),
          ...(f.fuzzy ? [] : [`Run \`ts-axi def ${label} --fuzzy\` for substring matches`]),
        ]),
      );
    }
    if (groups.length > 1) {
      return out(
        block({ ...warning, symbol: label, ambiguous: `${groups.length} Symbols - pick one`, ...matchRows(groups) }),
        helpBlock(narrowHints(opened, name, groups, f, `${label}${filterSuffix(f, project)}`, target)),
      );
    }
    const decl = groups[0]!.decls[0]!;
    resolved = { absFile: opened.index.abs(decl.file), pos: decl.namePos, decl, seeds: [...new Set(groups[0]!.decls.map((d) => opened.index.abs(d.file)))] };
  } else {
    const at = resolvePosition(opened.index, ctx.cwd, target);
    if (at.kind === "none") {
      return out(block({ ...warning, matches: 0, reason: at.reason }), helpBlock([`Run \`ts-axi outline ${at.file}\` to see the Declarations of the file`]));
    }
    if (at.kind === "ambiguous") {
      return out(
        block({ ...warning, position: label, ambiguous: `${at.candidates.length} identifiers on the line - add a column`, identifiers: at.candidates }),
        helpBlock(at.candidates.slice(0, 3).map((c) => `Run \`ts-axi ${name} ${at.file}:${c.line}:${c.col}\` for ${c.name}`)),
      );
    }
    resolved = at.kind === "decl" ? { absFile: at.abs, pos: at.decl.namePos, decl: at.decl } : { absFile: at.abs, pos: at.pos };
  }

  let built = semanticFor(opened, resolved.seeds ?? [resolved.absFile], resolved.decl ? REFS_HOPS : 0);
  if (!resolved.decl && built.scope) {
    // A use position: find its Declaration in a small program, then scope around the declaring file.
    const at = built.semantic.definitionAt(resolved.absFile, resolved.pos);
    if (at && at.line > 0) resolved = { absFile: at.absFile, pos: at.pos };
    built = semanticFor(opened, [resolved.absFile], REFS_HOPS);
  }
  const { semantic, scope } = built;
  const def = semantic.definitionAt(resolved.absFile, resolved.pos);
  const found =
    resolved.decl ??
    (def && def.line > 0 ? declarationAt(opened.index, def.absFile, def.pos, kindFromScriptElement(def.kind)) : undefined);
  // A function registered by identifier is its registration: templates, note and textual use the registered name.
  const decl = (found && registrationOf(found, opened.index.declarations(opened.index.abs(found.file)))) ?? found;
  const kind: Kind = decl?.kind ?? kindFromScriptElement(def?.kind ?? semantic.quickInfo(resolved.absFile, resolved.pos)?.kind ?? "");
  const symbol = decl?.qualifiedName ?? def?.name ?? label;
  const declaredAt = decl ? `${decl.file}:${decl.nameLine}` : def && def.line > 0 ? `${def.file}:${def.line}` : "(outside the Project)";
  const header = { ...warning, ...projectFields(opened), symbol, kind, declared_at: declaredAt };
  const explicit = Boolean(project || opened.settings.project);
  const declaredFile = decl?.file ?? (def && def.line > 0 ? def.file : undefined);
  const localFile = isPlainLocal(decl) ? opened.index.abs(decl.file) : undefined;
  const needle = textualNeedle(decl ?? symbol, kind);
  const textual = declaredFile !== undefined && needle && isUntyped(opened, decl, declaredFile) ? textualCount(opened, needle, new Map(), localFile) : undefined;
  const tplTarget = decl ? templateTarget(decl, opened.index.declarations(opened.index.abs(decl.file))) : undefined;
  const templates = tplTarget ? templateRows(loadTemplates(opened.root), tplTarget) : undefined;
  const o = { started, symbol, kind, declaredAt, show, scope, explicit, label, name, absFile: resolved.absFile, ...(decl ? { decl } : {}), ...(textual ? { textual } : {}), ...(templates ? { templates } : {}) };

  return mode === "calls"
    ? renderCallers(semantic, opened, resolved, header, { ...o, limit, depth })
    : renderRefs(semantic, opened, resolved, header, { ...o, limit, kind });
}

interface Common {
  started: number;
  symbol: string;
  declaredAt: string;
  show: Show;
  scope: ScopeInfo | undefined;
  /** -P or .ts-axi.json project selected the Project. */
  explicit: boolean;
  label: string;
  name: string;
  absFile: string;
  kind: Kind;
  decl?: Declaration;
  /** Whole-word count of the name for untyped Symbols (see `isUntyped`). */
  textual?: TextualCount;
  /** Template usages, for Symbols templates can name (directives, components, bindings, controllers, filters). */
  templates?: Unresolved[];
}

/** Template usages as `--grep` rows. */
export function templateRows(files: ReturnType<typeof loadTemplates>, target: NonNullable<ReturnType<typeof templateTarget>>): Unresolved[] {
  const texts = new Map(files.map((f) => [f.rel, f.text] as const));
  return templateUsages(files, target).map((u) => ({ file: u.file, line: u.line, context: contextOf(lineOf(texts.get(u.file), u.line), u.col) }));
}

/** `templates` field and the hint to list them. */
function templateFields(o: Common, grepShown: boolean): { fields: Record<string, unknown>; help: string[] } {
  if (!o.templates) return { fields: {}, help: [] };
  const n = o.templates.length;
  return {
    fields: { templates: templatesLine(o.templates) },
    help: n > 0 && !grepShown ? [`Run \`ts-axi refs ${o.declaredAt} --grep\` for the ${n} template usages`] : [],
  };
}

/** Textual rows plus template rows, one per file:line, sorted. */
function withTemplates(unresolved: Unresolved[], templates: Unresolved[] | undefined): Unresolved[] {
  if (!templates || templates.length === 0) return unresolved;
  const seen = new Set(unresolved.map((u) => `${u.file}:${u.line}`));
  return [...unresolved, ...templates.filter((t) => !seen.has(`${t.file}:${t.line}`))].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const OUTSIDE_ROWS = 5;

/**
 * No References under an explicit Project: importers of the declaring file (or of a barrel
 * re-exporting it) elsewhere in the workspace, from the syntactic importer index.
 */
function outsideImporters(opened: Opened, o: Common): { fields: Record<string, unknown>; help: string[] } {
  if (!o.explicit) return { fields: {}, help: [] };
  const workspace = detectWorkspace(opened.root);
  if (!isMultiProject(workspace.kind)) return { fields: {}, help: [] };
  const index = importerIndexFor(opened.index, workspace);
  const closure = importerClosure(index, [o.absFile], REFS_HOPS);
  const inProject = new Set(opened.index.files);
  const barrels = new Set(closure.barrels);
  const targets = [o.absFile, ...closure.barrels];
  const needle = textualNeedle(o.symbol, o.kind)?.text;
  if (!needle) return { fields: {}, help: [] };
  const rows = closure.importers
    .filter((f) => !inProject.has(f) && !barrels.has(f) && (opened.index.text(f) ?? "").includes(needle))
    .map((f) => {
      const line = targets.flatMap((t) => index.importersOf(t)).find((i) => i.file === f)?.line ?? 1;
      return { file: opened.index.rel(f), line };
    })
    .sort((a, b) => byDepthThenPath(a.file, b.file));
  if (rows.length === 0) return { fields: {}, help: [] };
  return {
    fields: {
      found_outside_project: rows.slice(0, OUTSIDE_ROWS),
      ...(rows.length > OUTSIDE_ROWS ? { found_outside_total: rows.length } : {}),
      hint: `${rows.length} files outside the selected project import it - run without -P for workspace scope`,
    },
    help: [`Run \`ts-axi ${o.name} ${o.label}\` without -P to search the whole workspace`],
  };
}

interface Row {
  file: string;
  line: number;
  col: number;
}

function sortRows<T extends Row>(rows: T[]): T[] {
  return rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
}

function summary(opened: Opened, rows: Row[]): { files: number; tests: number; fileList: string[] } {
  const fileList = [...new Set(rows.map((r) => r.file))];
  return { files: fileList.length, tests: fileList.filter((file) => isTestFile(file, opened.settings)).length, fileList };
}

function contextCell(opened: Opened, row: Row): string {
  return contextOf(lineOf(opened.index.text(opened.index.abs(row.file)), row.line), row.col);
}

function footer(semantic: SemanticProject, started: number, touched: string[]): Record<string, unknown> {
  const diagnostics = semantic.diagnosticsCount(touched);
  return { elapsed_ms: Math.round(performance.now() - started), ...(diagnostics > 0 ? { diagnostics } : {}) };
}

interface Show {
  via: boolean;
  implementations: boolean;
  grep: boolean;
}

const NAMELESS_NOTE = "registered by a string - References to it are textual (templates; DI arrays; route configs)";

interface ViaRow extends Row {
  via?: string;
  through?: "base" | "implementation";
}

/** `via_interface` / `via_implementations` counts, plus the hint to see their rows. */
function viaFields(via: ViaRow[], bases: string[]): Record<string, unknown> {
  const base = via.filter((v) => v.through === "base");
  const impl = via.filter((v) => v.through === "implementation");
  return {
    ...(bases.length > 0 || base.length > 0 ? { via_interface: viaLine(base.length, [...bases, ...base.map((v) => v.via!)]) } : {}),
    ...(impl.length > 0 ? { via_implementations: viaLine(impl.length, impl.map((v) => v.via!)) } : {}),
  };
}

/** Whole-word matches of the name on lines that hold no known position (what `--grep` lists). */
function unresolvedOf(opened: Opened, semantic: SemanticProject, o: Common, known: readonly Row[]): Unresolved[] {
  const needle = isTextualCandidate(o.decl) ? textualNeedle(o.decl ?? o.symbol, o.kind) : undefined;
  if (!needle) return [];
  return textualMatches(
    opened,
    semantic,
    [needle],
    new Set(known.map((r) => `${r.file}:${r.line}`)),
    new Set(o.decl ? [`${o.decl.file}:${o.decl.line}`, `${o.decl.file}:${o.decl.nameLine}`] : []),
    new Map(),
    isPlainLocal(o.decl) ? new Map([[o.decl.name, opened.index.abs(o.decl.file)]]) : new Map(),
  );
}

/**
 * `textual` field and, when the name occurs more often than refs_total and some matches sit on no
 * Reference line (`unresolved` = the `--grep` rows), the `--grep` hint.
 */
function textualFields(o: Common, refsTotal: number, unresolved: number, grepShown: boolean): { fields: Record<string, unknown>; help: string[] } {
  if (!o.textual) return { fields: {}, help: [] };
  const gap = o.textual.matches > refsTotal ? unresolved : 0;
  return {
    fields: { textual: textualLine(o.textual) },
    help: gap > 0 && !grepShown ? [textualHint(`ts-axi refs ${o.declaredAt} --grep`, gap)] : [],
  };
}

/** Direct rows, plus via rows (with a `via` column) under `--via`. */
function mergedRows<T extends ViaRow>(direct: T[], via: T[], show: Show): T[] {
  return show.via ? sortRows([...direct, ...via]) : direct;
}

function renderRefs(
  semantic: SemanticProject,
  opened: Opened,
  resolved: Resolved,
  header: Record<string, unknown>,
  o: Common & { limit: number; kind: Kind },
): string {
  const split = semantic.referenceSplit(resolved.absFile, resolved.pos);
  const rows = sortRows([...split.direct]);
  const via = sortRows([...split.via]);
  const impls = sortRows([...split.implementations]);
  const { files, tests, fileList } = summary(opened, rows);
  const listed = mergedRows<ViaRow>(rows, via, o.show);
  const shown = listed.slice(0, o.limit);
  const truncated = shown.length < listed.length;
  const help: string[] = [];
  if (truncated) {
    help.push(
      o.limit < MAX_LIMIT
        ? `Showing ${shown.length} of ${listed.length}; run \`ts-axi refs ${o.declaredAt}${o.show.via ? " --via" : ""} --limit ${Math.min(MAX_LIMIT, listed.length)}\` for more`
        : `Showing ${shown.length} of ${listed.length}; narrow by reading one file at a time`,
    );
  }
  if (via.length > 0 && !o.show.via) help.push(`Run \`ts-axi refs ${o.declaredAt} --via\` for the ${via.length} via References (${viaNames(via)})`);
  if (impls.length > 0 && !o.show.implementations) help.push(`Run \`ts-axi refs ${o.declaredAt} --implementations\` to list the ${impls.length} implementations`);
  const outside = rows.length === 0 ? outsideImporters(opened, o) : { fields: {}, help: [] };
  help.unshift(...outside.help);
  const word = textualNeedle(o.symbol, o.kind)?.text ?? "";
  const unresolved = o.show.grep || o.textual || o.templates ? unresolvedOf(opened, semantic, o, [...rows, ...via, ...impls]) : [];
  const grepRows = withTemplates(unresolved, o.templates);
  // The --grep hint counts what --grep lists: textual and template rows together.
  const text = textualFields(o, rows.length, grepRows.length, o.show.grep);
  const tpl = templateFields(o, o.show.grep || text.help.length > 0);
  if (text.help.length > 0) help.unshift(...text.help);
  else if (o.decl?.nameless && word && !o.show.grep && tpl.help.length === 0) help.unshift(`Run \`ts-axi refs ${o.declaredAt} --grep\` for textual matches of '${word}'`);
  help.unshift(...tpl.help);
  if (isFunctionLike(o.kind)) help.push(`Run \`ts-axi callers ${o.declaredAt}\` for call sites with their enclosing function`);
  help.push(`Run \`ts-axi def ${o.declaredAt}\` for the declaration body`);
  help.push(...scopeHelp(o.scope));
  return out(
    block({
      ...header,
      ...(o.decl?.nameless ? { note: NAMELESS_NOTE } : {}),
      refs_total: rows.length,
      ...text.fields,
      ...tpl.fields,
      files,
      tests,
      ...viaFields(via, split.bases),
      ...(impls.length > 0
        ? { implementations: o.show.implementations ? impls.map((r) => ({ file: r.file, line: r.line, symbol: r.name })) : impls.length }
        : {}),
      ...(shown.length === 0
        ? {}
        : {
            refs: shown.map((r) => ({
              file: r.file,
              line: r.line,
              ...(o.show.via ? { via: r.via ?? "-" } : {}),
              context: contextCell(opened, r),
            })),
          }),
      ...(truncated ? { truncated: true } : {}),
      ...(o.show.grep ? { unresolved: grepRows.length === 0 ? 0 : grepRows.slice(0, o.limit) } : {}),
      ...(grepRows.length > o.limit ? { unresolved_total: grepRows.length } : {}),
      ...outside.fields,
      ...scopeFields(o.scope),
      ...footer(semantic, o.started, fileList),
    }),
    helpBlock(help),
  );
}

function viaNames(via: ViaRow[]): string {
  return [...new Set(via.map((v) => v.via))].join("; ");
}

function itemKey(site: CallSite): string {
  return `${site.item.file}#${site.item.selectionSpan.start}`;
}

/** Aggregate one more level of incoming calls: `{caller,file,count}` per calling function. */
function nextLevel(semantic: SemanticProject, sites: CallSite[], visited: Set<string>): CallSite[] {
  const next: CallSite[] = [];
  const items = new Map<string, CallSite>();
  for (const site of sites) if (!items.has(itemKey(site))) items.set(itemKey(site), site);
  for (const [key, site] of items) {
    if (visited.has(key)) continue;
    visited.add(key);
    next.push(...semantic.incomingCallsOf(site.item));
  }
  return next;
}

function depthRows(sites: CallSite[]): Array<{ caller: string; file: string; count: number }> {
  const counts = new Map<string, { caller: string; file: string; count: number }>();
  for (const site of sites) {
    const key = `${site.file}#${site.caller}`;
    const entry = counts.get(key) ?? { caller: site.caller, file: site.file, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

function renderCallers(
  semantic: SemanticProject,
  opened: Opened,
  resolved: Resolved,
  header: Record<string, unknown>,
  o: Common & { limit: number; depth: number },
): string {
  const sites = semantic.incomingCalls(resolved.absFile, resolved.pos);
  // Every Reference line counts as known: the gap is what `refs --grep` would list.
  const callerText = o.textual
    ? (() => {
        const split = semantic.referenceSplit(resolved.absFile, resolved.pos);
        const known = [...split.direct, ...split.declarations, ...split.via, ...split.implementations, ...split.dropped, ...(sites ?? [])];
        const calls = (sites ?? []).filter((s) => s.via === undefined).length;
        return textualFields(o, calls, withTemplates(unresolvedOf(opened, semantic, o, known), o.templates).length, false);
      })()
    : { fields: {}, help: [] };
  const tpl = templateFields(o, callerText.help.length > 0);
  callerText.fields = { ...callerText.fields, ...tpl.fields };
  callerText.help = [...tpl.help, ...callerText.help];
  if (sites === undefined) {
    return out(
      block({ ...header, refs_total: 0, ...callerText.fields, note: "not callable - no call hierarchy for this Symbol", ...scopeFields(o.scope), ...footer(semantic, o.started, []) }),
      helpBlock([...callerText.help, `Run \`ts-axi refs ${o.declaredAt}\` for every Reference`]),
    );
  }
  const rows = sortRows(sites.filter((s) => s.via === undefined));
  const via = sortRows(sites.filter((s) => s.via !== undefined));
  const { files, tests, fileList } = summary(opened, rows);
  const listed = mergedRows<CallSite>(rows, via, o.show);
  const shown = listed.slice(0, o.limit);
  const truncated = shown.length < listed.length;

  const levels: Record<string, unknown> = {};
  const visited = new Set<string>();
  let level = listed;
  for (let d = 2; d <= o.depth; d++) {
    level = nextLevel(semantic, level, visited);
    const agg = depthRows(level);
    levels[`callers_depth${d}`] = agg.length === 0 ? 0 : agg.slice(0, DEPTH_ROWS);
    if (agg.length > DEPTH_ROWS) levels[`callers_depth${d}_total`] = agg.length;
    if (level.length === 0) break;
  }

  const help: string[] = [];
  if (truncated) {
    help.push(`Showing ${shown.length} of ${listed.length}; run \`ts-axi callers ${o.declaredAt}${o.show.via ? " --via" : ""} --limit ${Math.min(MAX_LIMIT, listed.length)}\` for more`);
  }
  if (via.length > 0 && !o.show.via) help.push(`Run \`ts-axi callers ${o.declaredAt} --via\` for the ${via.length} via calls (${viaNames(via)})`);
  const top = shown.find((r) => r.caller !== "(top-level)");
  if (top && o.depth === 1) help.push(`Run \`ts-axi callers ${o.declaredAt} --depth 2\` for who calls the callers`);
  const outside = rows.length === 0 ? outsideImporters(opened, o) : { fields: {}, help: [] };
  help.unshift(...outside.help);
  help.unshift(...callerText.help);
  help.push(`Run \`ts-axi refs ${o.declaredAt}${o.decl?.nameless ? " --grep" : ""}\` for every Reference (not only calls)`);
  help.push(...scopeHelp(o.scope));
  return out(
    block({
      ...header,
      ...(o.decl?.nameless ? { note: NAMELESS_NOTE } : {}),
      refs_total: rows.length,
      ...callerText.fields,
      files,
      tests,
      ...viaFields(via, []),
      ...(shown.length === 0
        ? {}
        : {
            refs: shown.map((r) => ({
              file: r.file,
              line: r.line,
              caller: r.caller,
              ...(o.show.via ? { via: r.via ?? "-" } : {}),
              context: contextCell(opened, r),
            })),
          }),
      ...(truncated ? { truncated: true } : {}),
      ...levels,
      ...outside.fields,
      ...scopeFields(o.scope),
      ...footer(semantic, o.started, fileList),
    }),
    helpBlock(help),
  );
}

