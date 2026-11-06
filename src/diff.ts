// Pure unified-diff parser (git style, `-U0` or any context size). No I/O.

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffLine {
  /** Old-file line number for removed lines, new-file line number for added ones. */
  line: number;
  text: string;
}

/** An unchanged line shown in a hunk, with its number on each side. */
export interface ContextLine {
  oldLine: number;
  newLine: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  removed: DiffLine[];
  added: DiffLine[];
  context: ContextLine[];
}

export interface FileDiff {
  /** Path after the change; the old path for a deleted file. */
  path: string;
  /** Previous path, renamed files only. */
  oldPath: string | undefined;
  status: FileStatus;
  hunks: Hunk[];
  /** A binary entry (no hunks); only returned with `{ binary: true }`. */
  binary?: true;
}

export type Range = [start: number, end: number];

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface Draft {
  gitOld?: string;
  gitNew?: string;
  minus?: string | null; // null = /dev/null
  plus?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newMode: boolean;
  deletedMode: boolean;
  binary: boolean;
  sawMinus: boolean;
  hunks: Hunk[];
}

/** Decode a git-quoted path (`"a\303\251b"`); plain paths pass through. */
function unquote(raw: string): string {
  const p = raw.split("\t")[0]!.trimEnd();
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const bytes: number[] = [];
  const body = p.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[++i] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(i, i + 3));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 2;
    } else {
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
      bytes.push(...Buffer.from(map[next] ?? next, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripPrefix(path: string, prefix: "a/" | "b/"): string {
  return path.startsWith(prefix) ? path.slice(2) : path;
}

/** Old/new paths from `diff --git a/x b/y`; ambiguous with spaces, so refined later by ---/+++ lines. */
function parseGitHeader(rest: string): [string | undefined, string | undefined] {
  // Same path on both sides (the common case) splits unambiguously by length.
  const length = (rest.length - 5) / 2;
  if (Number.isInteger(length) && length > 0 && rest.startsWith("a/") && rest.slice(2, 2 + length) === rest.slice(rest.length - length) && rest.slice(2 + length, 5 + length) === " b/") {
    const path = rest.slice(2, 2 + length);
    return [path, path];
  }
  const m = /^"?a\/(.+?)"? "?b\/(.+?)"?$/.exec(rest);
  return m ? [m[1], m[2]] : [undefined, undefined];
}

function finish(draft: Draft, keepBinary: boolean): FileDiff | undefined {
  if (draft.binary && !keepBinary) return undefined;
  const isNew = draft.newMode || draft.minus === null;
  const isDeleted = draft.deletedMode || draft.plus === null;
  const oldP = draft.renameFrom ?? (draft.minus ? draft.minus : undefined) ?? draft.gitOld;
  const newP = draft.renameTo ?? (draft.plus ? draft.plus : undefined) ?? draft.gitNew;
  const path = isDeleted ? (oldP ?? newP) : (newP ?? oldP);
  if (path === undefined) return undefined;
  let status: FileStatus = "modified";
  if (isNew) status = "added";
  else if (isDeleted) status = "deleted";
  else if (oldP !== undefined && newP !== undefined && oldP !== newP) status = "renamed";
  return {
    path,
    oldPath: status === "renamed" ? oldP : undefined,
    status,
    hunks: draft.hunks,
    ...(draft.binary ? { binary: true as const } : {}),
  };
}

/**
 * Parse git-style unified diff text. Binary files are skipped unless `binary` is set; files
 * with no hunks (pure renames, mode changes) are kept with `hunks: []`. Splits on `\n` only,
 * so `\r`, U+2028 or U+2029 inside a line never shift the numbering.
 */
export function parseUnifiedDiff(text: string, options: { binary?: boolean } = {}): FileDiff[] {
  const files: FileDiff[] = [];
  let draft: Draft | undefined;
  let hunk: Hunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;

  const flush = (): void => {
    if (draft) {
      const file = finish(draft, options.binary === true);
      if (file) files.push(file);
    }
    draft = undefined;
    hunk = undefined;
    oldLeft = newLeft = 0;
  };
  const fresh = (): Draft => ({ newMode: false, deletedMode: false, binary: false, sawMinus: false, hunks: [] });

  for (const line of text.split("\n")) {
    // Inside a hunk the counts decide what a line is: a removed line "-- x" looks like a header.
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const tag = line.charAt(0);
      if (tag === "\\") continue;
      if (tag === "-") {
        hunk.removed.push({ line: oldNo++, text: line.slice(1) });
        oldLeft--;
        continue;
      }
      if (tag === "+") {
        hunk.added.push({ line: newNo++, text: line.slice(1) });
        newLeft--;
        continue;
      }
      if (tag === " " || line === "") {
        hunk.context.push({ oldLine: oldNo, newLine: newNo });
        oldNo++;
        newNo++;
        oldLeft--;
        newLeft--;
        continue;
      }
      // Truncated hunk: fall through and treat the line as a header.
      oldLeft = newLeft = 0;
    }

    if (line.startsWith("\\")) continue;

    if (line.startsWith("diff --git ")) {
      flush();
      draft = fresh();
      [draft.gitOld, draft.gitNew] = parseGitHeader(line.slice("diff --git ".length));
      continue;
    }

    const h = HUNK_HEADER.exec(line);
    if (h && draft) {
      hunk = {
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        removed: [],
        added: [],
        context: [],
      };
      draft.hunks.push(hunk);
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }

    if (line.startsWith("--- ")) {
      // Plain `diff -u` has no `diff --git` line: a second `---` starts the next file.
      if (!draft || draft.sawMinus || draft.hunks.length > 0) {
        flush();
        draft = fresh();
      }
      draft.sawMinus = true;
      const p = unquote(line.slice(4));
      draft.minus = p === "/dev/null" ? null : stripPrefix(p, "a/");
      continue;
    }
    if (!draft) continue;

    if (line.startsWith("+++ ")) {
      const p = unquote(line.slice(4));
      draft.plus = p === "/dev/null" ? null : stripPrefix(p, "b/");
    } else if (line.startsWith("new file mode")) {
      draft.newMode = true;
    } else if (line.startsWith("deleted file mode")) {
      draft.deletedMode = true;
    } else if (line.startsWith("rename from ")) {
      draft.renameFrom = unquote(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      draft.renameTo = unquote(line.slice("rename to ".length));
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      draft.binary = true;
    }
  }
  flush();
  return files;
}

function mergeRanges(lines: number[]): Range[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: Range[] = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && n <= last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

/**
 * Changed line ranges (1-based, inclusive, merged and sorted). `after` covers
 * added lines in the new file, `before` removed lines in the old file; a pure
 * deletion therefore only appears in `before`.
 */
export function changedRanges(file: FileDiff): { after: Range[]; before: Range[] } {
  return {
    after: mergeRanges(file.hunks.flatMap((h) => h.added.map((l) => l.line))),
    before: mergeRanges(file.hunks.flatMap((h) => h.removed.map((l) => l.line))),
  };
}

/**
 * Left side of a git range, the revision the "before" version is read from:
 * `main...HEAD` -> `main`, `a..b` -> `a`, `X` -> `X`, none -> `HEAD`.
 * Merge-base semantics of `...` are resolved by `resolveBaseRev` in git.ts.
 */
export function baseRevOfRange(range?: string): string {
  if (range === undefined || range === "") return "HEAD";
  const triple = range.indexOf("...");
  const index = triple !== -1 ? triple : range.indexOf("..");
  if (index === -1) return range;
  return range.slice(0, index) || "HEAD";
}

/** Right side of a range; undefined when git diffs it against the working tree (`abc123`). */
export function headRevOfRange(range: string): string | undefined {
  const triple = range.indexOf("...");
  if (triple > 0) return range.slice(triple + 3) || "HEAD";
  const double = range.indexOf("..");
  if (double > 0) return range.slice(double + 2) || "HEAD";
  return undefined;
}
