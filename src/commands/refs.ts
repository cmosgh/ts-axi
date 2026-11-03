import { expectPositionals, flag, intFlag, parseArgs } from "../args.js";
import type { CommandContext } from "../context.js";
import { createSemanticProject, type CallSite, type SemanticProject } from "../project.js";
import { block, helpBlock, out } from "../render.js";
import { isTestFile } from "../settings.js";
import { isFunctionLike, kindFromScriptElement, parseTarget, type Declaration, type Kind } from "../symbols.js";
import {
  contextOf,
  declarationAt,
  filterSuffix,
  lineOf,
  matchRows,
  narrowHints,
  open,
  positionStartDir,
  readFilters,
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

const SHARED_FLAGS = `--kind <function|class|method|property|variable|interface|type|enum|enum-member|namespace> (narrows a name), --in <dir|glob> (repeatable; Declarations in these files), --exported, --fuzzy, --limit <1-${MAX_LIMIT}> (default ${DEFAULT_LIMIT} rows), --test-glob <glob> (repeatable; extra Test file pattern), -P <tsconfig>, --json`;

export const REFS_HELP = `usage: ts-axi refs <name | Class.member | path:line[:col]> [flags]
flags[9]:
  ${SHARED_FLAGS}
  --kind calls = same as \`ts-axi callers\`
output:
  symbol, kind, declared_at, refs_total, files, tests, refs[n]{file,line,context} (Declarations excluded), elapsed_ms
  an ambiguous name lists matches[n] + the disambiguated forms; nothing is analysed
examples[4]:
  ts-axi refs User.save
  ts-axi refs src/models/user.ts:12
  ts-axi refs parse --in src/models
  ts-axi refs runSync --limit 200
`;

export const CALLERS_HELP = `usage: ts-axi callers <name | Class.member | path:line[:col]> [flags]
flags[10]:
  ${SHARED_FLAGS}
  --depth <1-3> (default 1; levels > 1 print callers_depthN[n]{caller,file,count}, no locations)
output:
  symbol, kind, declared_at, refs_total, files, tests, refs[n]{file,line,caller,context}, elapsed_ms
  caller = enclosing function or method; (top-level) for module code
examples[3]:
  ts-axi callers runSync
  ts-axi callers User.save --depth 2
  ts-axi callers src/services/sync.ts:20
`;

interface Resolved {
  absFile: string;
  pos: number;
  decl?: Declaration;
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
    ...(invoked === "calls" ? [{ name: "--depth" }] : []),
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
  const started = performance.now();
  const opened = open(ctx.cwd, parsed, positionStartDir(ctx.cwd, target));
  const warning = opened.warning ? { warning: opened.warning } : {};

  // Resolve to exactly one Symbol before building a program.
  let resolved: Resolved;
  if (target.kind === "name") {
    const groups = resolveNameTarget(opened, target, f);
    if (groups.length === 0) {
      const suggested = suggestions(opened, target);
      return out(
        block({ ...warning, matches: 0, ...(suggested.length > 0 ? { did_you_mean: suggested } : {}) }),
        helpBlock([
          ...suggested.slice(0, 2).map((s) => `Run \`ts-axi ${name} ${s}\``),
          ...(f.fuzzy ? [] : [`Run \`ts-axi def ${label} --fuzzy\` for substring matches`]),
        ]),
      );
    }
    if (groups.length > 1) {
      return out(
        block({ ...warning, symbol: label, ambiguous: `${groups.length} Symbols - pick one`, matches: matchRows(groups) }),
        helpBlock(narrowHints(name, groups, f, `${label}${filterSuffix(f, project)}`)),
      );
    }
    const decl = groups[0]!.decls[0]!;
    resolved = { absFile: opened.index.abs(decl.file), pos: decl.namePos, decl };
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

  const semantic = createSemanticProject(opened.index);
  const def = semantic.definitionAt(resolved.absFile, resolved.pos);
  const decl =
    resolved.decl ??
    (def && def.line > 0 ? declarationAt(opened.index, def.absFile, def.pos, kindFromScriptElement(def.kind)) : undefined);
  const kind: Kind = decl?.kind ?? kindFromScriptElement(def?.kind ?? semantic.quickInfo(resolved.absFile, resolved.pos)?.kind ?? "");
  const symbol = decl?.qualifiedName ?? def?.name ?? label;
  const declaredAt = decl ? `${decl.file}:${decl.nameLine}` : def && def.line > 0 ? `${def.file}:${def.line}` : "(outside the Project)";
  const header = { ...warning, symbol, kind, declared_at: declaredAt };

  return mode === "calls"
    ? renderCallers(semantic, opened, resolved, header, { limit, depth, started, symbol, declaredAt })
    : renderRefs(semantic, opened, resolved, header, { limit, started, symbol, declaredAt, kind });
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

function renderRefs(
  semantic: SemanticProject,
  opened: Opened,
  resolved: Resolved,
  header: Record<string, unknown>,
  o: { limit: number; started: number; symbol: string; declaredAt: string; kind: Kind },
): string {
  const rows = sortRows(semantic.findReferences(resolved.absFile, resolved.pos).filter((r) => !r.isDefinition));
  const { files, tests, fileList } = summary(opened, rows);
  const shown = rows.slice(0, o.limit);
  const truncated = shown.length < rows.length;
  const help: string[] = [];
  if (truncated) {
    help.push(
      o.limit < MAX_LIMIT
        ? `Showing ${shown.length} of ${rows.length}; run \`ts-axi refs ${o.declaredAt} --limit ${Math.min(MAX_LIMIT, rows.length)}\` for more`
        : `Showing ${shown.length} of ${rows.length}; narrow by reading one file at a time`,
    );
  }
  if (isFunctionLike(o.kind)) help.push(`Run \`ts-axi callers ${o.declaredAt}\` for call sites with their enclosing function`);
  help.push(`Run \`ts-axi def ${o.declaredAt}\` for the declaration body`);
  return out(
    block({
      ...header,
      refs_total: rows.length,
      files,
      tests,
      ...(rows.length === 0
        ? {}
        : { refs: shown.map((r) => ({ file: r.file, line: r.line, context: contextCell(opened, r) })) }),
      ...(truncated ? { truncated: true } : {}),
      ...footer(semantic, o.started, fileList),
    }),
    helpBlock(help),
  );
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
  o: { limit: number; depth: number; started: number; symbol: string; declaredAt: string },
): string {
  const sites = semantic.incomingCalls(resolved.absFile, resolved.pos);
  if (sites === undefined) {
    return out(
      block({ ...header, refs_total: 0, note: "not callable - no call hierarchy for this Symbol", ...footer(semantic, o.started, []) }),
      helpBlock([`Run \`ts-axi refs ${o.declaredAt}\` for every Reference`]),
    );
  }
  const rows = sortRows([...sites]);
  const { files, tests, fileList } = summary(opened, rows);
  const shown = rows.slice(0, o.limit);
  const truncated = shown.length < rows.length;

  const levels: Record<string, unknown> = {};
  const visited = new Set<string>();
  let level = rows;
  for (let d = 2; d <= o.depth; d++) {
    level = nextLevel(semantic, level, visited);
    const agg = depthRows(level);
    levels[`callers_depth${d}`] = agg.length === 0 ? 0 : agg.slice(0, DEPTH_ROWS);
    if (agg.length > DEPTH_ROWS) levels[`callers_depth${d}_total`] = agg.length;
    if (level.length === 0) break;
  }

  const help: string[] = [];
  if (truncated) {
    help.push(`Showing ${shown.length} of ${rows.length}; run \`ts-axi callers ${o.declaredAt} --limit ${Math.min(MAX_LIMIT, rows.length)}\` for more`);
  }
  const top = shown.find((r) => r.caller !== "(top-level)");
  if (top && o.depth === 1) help.push(`Run \`ts-axi callers ${o.declaredAt} --depth 2\` for who calls the callers`);
  help.push(`Run \`ts-axi refs ${o.declaredAt}\` for every Reference (not only calls)`);
  return out(
    block({
      ...header,
      refs_total: rows.length,
      files,
      tests,
      ...(rows.length === 0
        ? {}
        : { refs: shown.map((r) => ({ file: r.file, line: r.line, caller: r.caller, context: contextCell(opened, r) })) }),
      ...(truncated ? { truncated: true } : {}),
      ...levels,
      ...footer(semantic, o.started, fileList),
    }),
    helpBlock(help),
  );
}

