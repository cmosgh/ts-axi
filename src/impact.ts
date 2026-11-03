// Pure `impact` logic: changed ranges -> Declarations -> Change classes, ordering
// and row budgets. No git, no LanguageService: everything here is unit-testable.
import ts from "typescript";
import type { Hunk, Range } from "./diff.js";
import { parseSource } from "./project.js";
import { collectDeclarations, type Declaration, type Kind } from "./symbols.js";

export type ChangeClass = "added" | "removed" | "signature" | "body" | "type" | "modified";

const TYPE_LEVEL: ReadonlySet<Kind> = new Set(["interface", "type", "enum"]);

export interface FileInput {
  /** Repo-root-relative path after the change (old path for a deleted file). */
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  after: Range[];
  before: Range[];
  /** null = the file does not exist on that side; undefined = that side is unavailable. */
  afterText: string | null | undefined;
  beforeText: string | null | undefined;
}

export interface DeclChange {
  /** `qualifiedName#kind`: how a Declaration is matched across versions. */
  key: string;
  file: string;
  change: ChangeClass;
  /** The Declaration in the after version (absent for `removed`). */
  after?: Declaration;
  before?: Declaration;
}

export interface FileChanges {
  changes: DeclChange[];
  /** Changed lines outside any Declaration; `before` lines only when nothing changed after. */
  fileLevel?: { after: Range[]; before: Range[] };
}

export function matchKey(decl: Pick<Declaration, "qualifiedName" | "kind">): string {
  return `${decl.qualifiedName}#${decl.kind}`;
}

/** The smallest Declaration whose line span contains `line`. */
export function innermost(decls: readonly Declaration[], line: number): Declaration | undefined {
  let best: Declaration | undefined;
  for (const d of decls) {
    if (d.line <= line && line <= d.endLine && (!best || d.endLine - d.line < best.endLine - best.line)) best = d;
  }
  return best;
}

/** Members of an interface or enum stand for the type-level Declaration itself. */
export function liftTypeLevel(decls: readonly Declaration[], decl: Declaration): Declaration {
  let current = decl;
  for (let parent = current.parentName; parent !== undefined; ) {
    const owner = decls.find((d) => d.qualifiedName === parent && d.file === decl.file);
    if (!owner) break;
    if (TYPE_LEVEL.has(owner.kind)) current = owner;
    parent = owner.parentName;
  }
  return current;
}

/** Changed ranges -> touched Declarations (deduped, by match key) + lines outside any Declaration. */
export function mapRanges(decls: readonly Declaration[], ranges: readonly Range[]): { touched: Map<string, Declaration>; outside: number[] } {
  const touched = new Map<string, Declaration>();
  const outside: number[] = [];
  for (const [start, end] of ranges) {
    for (let line = start; line <= end; line++) {
      const hit = innermost(decls, line);
      if (!hit) {
        outside.push(line);
        continue;
      }
      const decl = liftTypeLevel(decls, hit);
      const key = matchKey(decl);
      if (!touched.has(key)) touched.set(key, decl);
    }
  }
  return { touched, outside };
}

export function toRanges(lines: readonly number[]): Range[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: Range[] = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && n <= last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

/** `1-3 7` (space-separated: no commas in TOON cells). */
export function formatRanges(ranges: readonly Range[]): string {
  return ranges.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(" ");
}

/** Full Signature per match key; overloads are joined so adding one is a `signature` change. */
export function signatures(decls: readonly Declaration[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const decl of decls) {
    const text = decl.fullSignature ?? decl.signature;
    const key = matchKey(decl);
    const prev = result.get(key);
    result.set(key, prev === undefined ? text : `${prev}\n${text}`);
  }
  return result;
}

function parsedDecls(path: string, text: string): { sf: ts.SourceFile; decls: Declaration[] } {
  const sf = parseSource(path, text);
  return { sf, decls: collectDeclarations(sf, path) };
}

/** Classify every Declaration a file's diff touches. */
export function classifyFile(input: FileInput): FileChanges {
  const afterSide = typeof input.afterText === "string" ? parsedDecls(input.path, input.afterText) : undefined;
  const beforeSide = typeof input.beforeText === "string" ? parsedDecls(input.oldPath ?? input.path, input.beforeText) : undefined;
  const beforeKnown = input.beforeText !== undefined;
  const afterDecls = afterSide?.decls ?? [];
  const beforeDecls = beforeSide?.decls ?? [];

  const afterMap = mapRanges(afterDecls, input.after);
  // Without a before text the before ranges cannot be mapped; the after side carries the change.
  const beforeMap = beforeSide ? mapRanges(beforeDecls, input.before) : { touched: new Map<string, Declaration>(), outside: [] };

  const afterByKey = new Map(afterDecls.map((d) => [matchKey(d), d] as const));
  const beforeByKey = new Map(beforeDecls.map((d) => [matchKey(d), d] as const));
  const afterSigs = afterSide ? signatures(afterDecls) : new Map<string, string>();
  const beforeSigs = beforeSide ? signatures(beforeDecls) : new Map<string, string>();

  const keys = [...new Set([...afterMap.touched.keys(), ...beforeMap.touched.keys()])];
  const changes: DeclChange[] = [];
  for (const key of keys) {
    const after = afterByKey.get(key);
    const before = beforeByKey.get(key);
    let change: ChangeClass;
    if (after && !before) change = beforeKnown ? "added" : "modified";
    else if (before && !after) change = "removed";
    else if (!beforeKnown) change = "modified";
    else if (TYPE_LEVEL.has(after!.kind)) change = "type";
    else change = afterSigs.get(key) === beforeSigs.get(key) ? "body" : "signature";
    changes.push({ key, file: input.path, change, ...(after ? { after } : {}), ...(before ? { before } : {}) });
  }

  // A whole added or deleted file: its imports are not news on their own.
  const wholeFile = input.status === "added" || input.status === "deleted";
  // Blank lines between Declarations are not a change of anything.
  const nonBlank = (text: string | null | undefined, lines: number[]): number[] => {
    if (typeof text !== "string") return lines;
    const all = text.split("\n");
    return lines.filter((n) => (all[n - 1] ?? "").trim() !== "");
  };
  const afterOutside = toRanges(nonBlank(input.afterText, afterMap.outside));
  const beforeOutside = toRanges(nonBlank(input.beforeText, beforeMap.outside));
  const fileLevel = !wholeFile && (afterOutside.length > 0 || beforeOutside.length > 0)
    ? { after: afterOutside, before: afterOutside.length > 0 ? [] : beforeOutside }
    : undefined;
  return { changes, ...(fileLevel ? { fileLevel } : {}) };
}

/**
 * Old file text from the new text and the hunks (`git apply -R` in memory).
 * null when the hunks do not match `afterText` (the diff is not of this checkout).
 */
export function reverseApply(afterText: string, hunks: readonly Hunk[]): string | null {
  const lines = afterText === "" ? [] : afterText.split("\n");
  const trailing = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  const before: string[] = [];
  let cursor = 1;
  for (const hunk of hunks) {
    const regionStart = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    if (regionStart < cursor || regionStart - 1 > lines.length) return null;
    for (; cursor < regionStart; cursor++) before.push(lines[cursor - 1]!);
    if (before.length !== (hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1)) return null;
    const added = new Map(hunk.added.map((l) => [l.line, l.text] as const));
    const removed = new Map(hunk.removed.map((l) => [l.line, l.text] as const));
    const context: string[] = [];
    for (let n = regionStart; n < regionStart + hunk.newLines; n++) {
      const text = lines[n - 1];
      if (text === undefined) return null;
      if (added.has(n)) {
        if (added.get(n) !== text) return null;
      } else {
        context.push(text);
      }
    }
    let c = 0;
    for (let o = hunk.oldStart; o < hunk.oldStart + hunk.oldLines; o++) {
      const text = removed.has(o) ? removed.get(o)! : context[c++];
      if (text === undefined) return null;
      before.push(text);
    }
    if (c !== context.length) return null;
    cursor = regionStart + hunk.newLines;
  }
  for (; cursor <= lines.length; cursor++) before.push(lines[cursor - 1]!);
  return before.length === 0 ? "" : `${before.join("\n")}${trailing ? "\n" : ""}`;
}

/** PLAN order: exported signature/removed, type, added, other signature/removed, body, modified. */
export function rankOf(change: ChangeClass, exported: boolean): number {
  switch (change) {
    case "signature":
    case "removed":
      return exported ? 0 : 3;
    case "type":
      return 1;
    case "added":
      return 2;
    case "body":
      return 4;
    default:
      return 5;
  }
}

export interface Ordered {
  change: ChangeClass;
  exported: boolean;
  refsOutside: number;
  file: string;
  line: number;
}

export function compareChanges(a: Ordered, b: Ordered): number {
  return (
    rankOf(a.change, a.exported) - rankOf(b.change, b.exported) ||
    b.refsOutside - a.refsOutside ||
    a.file.localeCompare(b.file) ||
    a.line - b.line
  );
}

/**
 * Split `budget` rows across symbols with `counts` rows each so that every
 * symbol keeps its first rows (water-filling: small lists stay whole).
 */
export function allocateBudget(counts: readonly number[], budget: number): number[] {
  const quotas = counts.map(() => 0);
  let left = budget;
  let open = counts.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);
  while (left > 0 && open.length > 0) {
    const share = Math.max(1, Math.floor(left / open.length));
    for (const i of open) {
      if (left === 0) break;
      const take = Math.min(share, counts[i]! - quotas[i]!, left);
      quotas[i]! += take;
      left -= take;
    }
    open = open.filter((i) => quotas[i]! < counts[i]!);
  }
  return quotas;
}

/** `3 (a body; b added; +1)`: at most `max` entries, no commas. */
export function localOnlyLine(entries: readonly string[], max = 10): string {
  const shown = entries.slice(0, max);
  const rest = entries.length - shown.length;
  return `${entries.length} (${[...shown, ...(rest > 0 ? [`+${rest}`] : [])].join("; ")})`;
}

/**
 * Whole-word occurrences of `name` in `text`: 1-based line and column. With `token`, `name` is a dotted
 * path (a state name): escaped literally, and neither `.` nor an identifier character may touch it.
 */
export function wordMatches(text: string, name: string, token = false): Array<{ line: number; col: number }> {
  const re = token
    ? new RegExp(`(?<![\\w$.])${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\w$.])`, "g")
    : new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`, "g");
  const result: Array<{ line: number; col: number }> = [];
  const lines = text.split("\n");
  lines.forEach((lineText, i) => {
    for (const m of lineText.matchAll(re)) result.push({ line: i + 1, col: (m.index ?? 0) + 1 });
  });
  return result;
}

export function inRanges(ranges: readonly Range[] | undefined, line: number): boolean {
  return ranges !== undefined && ranges.some(([a, b]) => a <= line && line <= b);
}
