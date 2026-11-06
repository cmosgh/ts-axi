// Pure `anchor` logic: is a file:line visible in a diff (where a review tool lets you comment)? No I/O.
import type { FileDiff, Range } from "./diff.js";
import { usageError } from "./errors.js";
import type { Declaration } from "./symbols.js";

export type Side = "new" | "old";

export interface Anchor {
  /** As given on the command line. */
  raw: string;
  path: string;
  start: number;
  end: number;
}

const ANCHOR = /^(.+):(\d+)(?:-(\d+))?$/;
const WITH_COLUMN = /^.+:\d+:\d+$/;

/** `path:line` or `path:start-end`; `path:line:col` counts too, so it gets a precise error. */
export function looksLikeAnchor(value: string): boolean {
  return value !== "-" && (ANCHOR.test(value) || WITH_COLUMN.test(value));
}

export function parseAnchor(raw: string): Anchor {
  if (WITH_COLUMN.test(raw)) {
    throw usageError(`anchor '${raw}' has a column - anchors are file:line or file:start-end`, [`Use ${raw.replace(/:\d+$/, "")}`]);
  }
  const m = ANCHOR.exec(raw);
  if (!m) throw usageError(`'${raw}' is not an anchor - expected file:line or file:start-end`);
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  if (start < 1) throw usageError(`anchor '${raw}' - lines start at 1`);
  if (end < start) throw usageError(`anchor '${raw}' ends before it starts`, [`Use ${m[1]}:${end}-${start}`]);
  return { raw, path: m[1]!.replace(/^\.\//, ""), start, end };
}

interface Shown {
  hunk: number;
  kind: "added" | "removed" | "context";
  /** The same line on the other side (context lines only). */
  other?: number;
}

export interface SideMap {
  /** Lines the diff shows on this side: added (new) or removed (old), plus context. */
  shown: Map<number, Shown>;
  /** Shown range of each hunk on this side, by hunk index; hunks with no line on it are absent. */
  hunks: Map<number, Range>;
}

export function sideMap(file: FileDiff, side: Side): SideMap {
  const shown = new Map<number, Shown>();
  const hunks = new Map<number, Range>();
  file.hunks.forEach((h, i) => {
    const own = side === "new" ? h.added : h.removed;
    for (const l of own) shown.set(l.line, { hunk: i, kind: side === "new" ? "added" : "removed" });
    for (const c of h.context) {
      const [line, other] = side === "new" ? [c.newLine, c.oldLine] : [c.oldLine, c.newLine];
      shown.set(line, { hunk: i, kind: "context", other });
    }
    const lines = [...own.map((l) => l.line), ...h.context.map((c) => (side === "new" ? c.newLine : c.oldLine))];
    if (lines.length > 0) hunks.set(i, [Math.min(...lines), Math.max(...lines)]);
  });
  return { shown, hunks };
}

/** Line count as an editor shows it: split on `\n` only, a trailing newline ends the last line. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function formatSpan([a, b]: Range): string {
  return a === b ? String(a) : `${a}-${b}`;
}

/** The closest range to [start, end]; ties go to the earlier one. */
export function nearestRange(ranges: readonly Range[], start: number, end: number): Range | undefined {
  let best: Range | undefined;
  let bestDistance = Infinity;
  for (const r of ranges) {
    const distance = end < r[0] ? r[0] - end : start > r[1] ? start - r[1] : 0;
    if (distance < bestDistance) {
      best = r;
      bestDistance = distance;
    }
  }
  return best;
}

export interface Verdict {
  ok: boolean;
  reason: string;
  inDiff: boolean;
  /** undefined = the file text on that side is not available. */
  inFile: boolean | undefined;
  /** Lines of the closest hunk on that side (`114-120`), same file as the anchor. */
  nearest?: string;
  /** Line on the other side for a context line. */
  otherLine?: number;
}

/**
 * Judge one anchor against its file's diff. `lines` = line count of the chosen side's text
 * (undefined when unknown). Every line of a range must be shown, in a single hunk.
 */
export function judge(anchor: Anchor, file: FileDiff | undefined, side: Side, lines: number | undefined): Verdict {
  if (!file) return { ok: false, reason: "file not in diff", inDiff: false, inFile: undefined };
  if (file.binary) return { ok: false, reason: "binary", inDiff: false, inFile: undefined };
  const inFile = lines === undefined ? undefined : anchor.end <= lines;
  if (side === "old" && file.status === "added") return { ok: false, reason: "file added - use --side new", inDiff: false, inFile: false };

  const map = sideMap(file, side);
  const hits: Shown[] = [];
  for (let n = anchor.start; n <= anchor.end; n++) {
    const hit = map.shown.get(n);
    if (hit) hits.push(hit);
  }
  const span = anchor.end - anchor.start + 1;
  const first = hits[0];
  if (first && hits.length === span && hits.every((h) => h.hunk === first.hunk)) {
    return { ok: inFile !== false, reason: inFile === false ? `past end of file (${lines} lines)` : "-", inDiff: true, inFile, ...(first.other !== undefined ? { otherLine: first.other } : {}) };
  }
  if (first) {
    const nearest = formatSpan(map.hunks.get(first.hunk)!);
    return { ok: false, reason: `crosses hunk boundary - hunk ${nearest}`, inDiff: false, inFile, nearest };
  }

  const otherSide = sideMap(file, side === "new" ? "old" : "new").shown.get(anchor.start);
  if (side === "new" && otherSide?.kind === "removed") return { ok: false, reason: "removed line - use --side old", inDiff: false, inFile };
  if (side === "old" && otherSide?.kind === "added") return { ok: false, reason: "added line - use --side new", inDiff: false, inFile };
  if (side === "new" && file.status === "deleted") return { ok: false, reason: "file deleted - use --side old", inDiff: false, inFile: false };
  if (inFile === false) return { ok: false, reason: `past end of file (${lines} lines)`, inDiff: false, inFile };
  const near = nearestRange([...map.hunks.values()], anchor.start, anchor.end);
  if (!near) return { ok: false, reason: `not in diff - no ${side}-side lines in this file`, inDiff: false, inFile };
  const nearest = formatSpan(near);
  return { ok: false, reason: `not in diff - nearest ${nearest}`, inDiff: false, inFile, nearest };
}

/** Smallest Declaration spanning the whole range. */
export function enclosing(decls: readonly Declaration[], start: number, end: number): Declaration | undefined {
  let best: Declaration | undefined;
  for (const d of decls) {
    if (d.line <= start && end <= d.endLine && (!best || d.endLine - d.line < best.endLine - best.line)) best = d;
  }
  return best;
}
