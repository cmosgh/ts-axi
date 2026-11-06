import { join, relative, sep } from "node:path";
import { enclosing, judge, lineCount, looksLikeAnchor, parseAnchor, type Anchor, type Side, type Verdict } from "../anchor.js";
import { bool, enumFlag, flag, intFlag, parseArgs, parseFields } from "../args.js";
import type { CommandContext } from "../context.js";
import { changedRanges, headRevOfRange, parseUnifiedDiff, type FileDiff } from "../diff.js";
import { ANCHOR_INVALID_EXIT, AxiError, usageError } from "../errors.js";
import { sourceFs } from "../fs.js";
import { diffUnified, isGitRepo, resolveBaseRev, showFile, untrackedFiles } from "../git.js";
import { classifyFile, liftTypeLevel, matchKey, reverseApply, type FileChanges } from "../impact.js";
import { findRepoRoot, parseSource, SOURCE_EXTENSIONS } from "../project.js";
import { block, helpBlock, out } from "../render.js";
import { collectDeclarations, type Declaration } from "../symbols.js";
import { readStdin, shellWord } from "./impact.js";

const DEFAULT_CONTEXT = 3;
const MAX_CONTEXT = 1000;
const STDIN_EXAMPLE = "bb-axi pr diff 42 --raw | ts-axi anchor - src/a.ts:12";

export const ANCHOR_HELP = `usage: ts-axi anchor [<git-range> | - | --staged] <file:line[-end]>... [flags]
checks review-comment anchors: a line is commentable when the diff shows it (an added or context line; removed or context with --side old)
input:
  (none) = working tree vs HEAD; --staged = index vs HEAD; <git-range> = any git diff range (main...HEAD)
  - = unified diff on stdin, used as given - the path for PR review (${STDIN_EXAMPLE})
  the diff source comes first; anchors are repo-relative file:line or file:start-end (every line of a range must be shown, in one hunk)
flags[5]:
  --side new|old (default new; old = lines of the before file - comments on removed lines), --context <0-${MAX_CONTEXT}> (git sources only; default ${DEFAULT_CONTEXT} like Bitbucket and GitHub), --staged, --fields <in_diff,in_file,nearest,change,other_line|all>, --json
output:
  base, head, side, anchors[n]{anchor,ok,reason,symbol}, invalid (count)
  reason = - when ok; else not in diff - nearest <file:a-b> | past end of file (<n> lines) | removed line - use --side old | crosses hunk boundary - hunk <file:a-b> | file not in diff | binary
  symbol = qualifiedName#kind of the innermost Declaration holding the line (a stable key for a finding); file_level outside any; - for non-TS/JS files
  in_diff = the line is shown in a hunk; in_file = within the line count of that side; nearest = closest hunk on that side
  change = impact class of that Symbol in this diff (signature, body, added, ...) or -; other_line = the same line on the other side (context lines) or -
exit codes:
  0 every anchor ok; 3 ANCHOR_INVALID = at least one is not (the full output still prints); 2 usage; 1 git
examples[4]:
  ${STDIN_EXAMPLE} src/b.ts:40-44
  ts-axi anchor main...HEAD src/a.ts:12
  ts-axi anchor --staged src/a.ts:12 --fields all
  ts-axi anchor main...HEAD src/a.ts:30 --side old
`;

const SPECS = [
  { name: "--staged", boolean: true },
  { name: "--side" },
  { name: "--context" },
  { name: "--fields" },
];

const ANCHOR_FIELDS = ["in_diff", "in_file", "nearest", "change", "other_line"] as const;

type Text = string | null | undefined;

interface Source {
  kind: "worktree" | "staged" | "range" | "stdin";
  range?: string;
  base: string;
  head: string;
}

function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Positionals -> diff source + anchors; the source is first when it is `-` or no file:line. */
function split(positionals: string[], staged: boolean): { source: string | undefined; anchors: string[] } {
  const [first, ...rest] = positionals;
  const source = first !== undefined && (first === "-" || !looksLikeAnchor(first)) ? first : undefined;
  const anchors = source === undefined ? positionals : rest;
  const stray = anchors.find((a) => !looksLikeAnchor(a));
  if (stray !== undefined) {
    const valid = anchors.filter(looksLikeAnchor);
    throw usageError(`'${stray}' is not an anchor - expected file:line or file:start-end`, [
      `the diff source goes first: \`ts-axi anchor ${shellWord(stray)} ${valid.map(shellWord).join(" ") || "src/a.ts:12"}\``,
    ]);
  }
  if (staged && source !== undefined) throw usageError("--staged cannot be combined with a range or -", [`Run \`ts-axi anchor --staged ${anchors.map(shellWord).join(" ")}\``]);
  if (anchors.length === 0) {
    throw usageError("no anchors given", [`Run \`ts-axi anchor ${source !== undefined ? `${shellWord(source)} ` : ""}src/a.ts:12\` (file:line or file:start-end)`]);
  }
  return { source, anchors };
}

export async function anchorCommand(args: string[], ctx: CommandContext): Promise<string> {
  const parsed = parseArgs(args, SPECS, "ts-axi anchor");
  const staged = bool(parsed, "--staged");
  const side = enumFlag<Side>(parsed, "--side", ["new", "old"], "new");
  const extras = new Set<string>(parseFields(flag(parsed, "--fields"), ANCHOR_FIELDS));
  const { source: arg, anchors: rawAnchors } = split(parsed.positionals, staged);
  if (arg === "-" && flag(parsed, "--context") !== undefined) {
    throw usageError("--context applies to git diffs - a stdin diff is used as given", [`Run \`${STDIN_EXAMPLE}\``]);
  }
  const context = intFlag(parsed, "--context", DEFAULT_CONTEXT, { min: 0, max: MAX_CONTEXT });
  const anchors = rawAnchors.map(parseAnchor);

  const root = findRepoRoot(ctx.cwd);
  let text: string;
  let source: Source;
  if (arg === "-") {
    text = ctx.stdin ?? (await readStdin("anchor", STDIN_EXAMPLE));
    source = { kind: "stdin", base: "stdin diff", head: "working tree" };
  } else {
    if (!(await isGitRepo(ctx.cwd))) {
      throw new AxiError("not a git repository - anchor needs git or a diff on stdin", "GIT_ERROR", [`Run \`${STDIN_EXAMPLE}\``]);
    }
    text = await diffUnified(ctx.cwd, arg, staged, context);
    const headRev = arg !== undefined ? headRevOfRange(arg) : undefined;
    source = staged
      ? { kind: "staged", base: "HEAD", head: "index" }
      : arg === undefined
        ? { kind: "worktree", base: "HEAD", head: "working tree" }
        : { kind: "range", range: arg, base: await resolveBaseRev(ctx.cwd, arg), head: headRev ?? "working tree" };
  }
  const files = parseUnifiedDiff(text, { binary: true });

  // Untracked files are wholly added in a working-tree diff (as in impact).
  let untracked: Set<string> | undefined;
  const findFile = async (path: string): Promise<FileDiff | undefined> => {
    const hit = files.find((f) => (side === "old" ? (f.oldPath ?? f.path) === path : f.path === path)) ?? files.find((f) => f.path === path || f.oldPath === path);
    if (hit || source.kind !== "worktree") return hit;
    untracked ??= new Set(await untrackedFiles(ctx.cwd));
    if (!untracked.has(path)) return undefined;
    const body = sourceFs().readFile(join(root, path)) ?? "";
    const n = lineCount(body);
    const added = Array.from({ length: n }, (_, i) => ({ line: i + 1, text: "" }));
    const file: FileDiff = { path, oldPath: undefined, status: "added", hunks: n > 0 ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: n, removed: [], added, context: [] }] : [] };
    files.push(file);
    return file;
  };
  // An anchor relative to a subdirectory cwd, or carrying an a/ or b/ prefix, still finds its file.
  const prefix = relative(root, ctx.cwd).split(sep).join("/");
  const resolveFile = async (anchor: Anchor): Promise<FileDiff | undefined> => {
    const candidates = [anchor.path, ...(prefix && !prefix.startsWith("..") ? [`${prefix}/${anchor.path}`] : []), ...(/^[ab]\//.test(anchor.path) ? [anchor.path.slice(2)] : [])];
    for (const c of candidates) {
      const f = await findFile(c);
      if (f) return f;
    }
    return undefined;
  };

  // --- Both sides of a file, read once ---
  const worktree = (path: string): string | null => sourceFs().readFile(join(root, path)) ?? null;
  const texts = new Map<FileDiff, Promise<{ after: Text; before: Text }>>();
  let mismatched = 0;
  const textsOf = (f: FileDiff): Promise<{ after: Text; before: Text }> => {
    let entry = texts.get(f);
    if (!entry) {
      entry = (async () => {
        if (f.binary) return { after: undefined, before: undefined };
        let after: Text;
        if (f.status === "deleted") after = null;
        else if (source.kind === "staged") after = await showFile(ctx.cwd, "", f.path);
        else if (source.kind === "range" && source.head !== "working tree") after = await showFile(ctx.cwd, source.head, f.path);
        else after = worktree(f.path);
        let before: Text;
        if (source.kind === "stdin") {
          // The checkout must be the diff's after side; otherwise both texts are unknown. A deleted file's hunks hold all of it.
          const reversed = reverseApply(after ?? "", f.hunks);
          if (reversed === null) {
            mismatched++;
            after = undefined;
          }
          before = f.status === "added" ? null : reversed ?? undefined;
        } else if (f.status === "added") before = null;
        else before = await showFile(ctx.cwd, source.base, f.oldPath ?? f.path);
        return { after, before };
      })();
      texts.set(f, entry);
    }
    return entry;
  };

  const decls = new Map<string, Declaration[]>();
  const declsOf = (path: string, sideText: string, key: string): Declaration[] => {
    let list = decls.get(key);
    if (!list) {
      list = collectDeclarations(parseSource(path, sideText), path);
      decls.set(key, list);
    }
    return list;
  };
  const classified = new Map<FileDiff, FileChanges>();
  const changesOf = (f: FileDiff, after: Text, before: Text): FileChanges => {
    let result = classified.get(f);
    if (!result) {
      const { after: a, before: b } = changedRanges(f);
      result = classifyFile({ path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, after: a, before: b, afterText: after, beforeText: before });
      classified.set(f, result);
    }
    return result;
  };

  const rows: Array<{ anchor: Anchor; verdict: Verdict; symbol: string; change: string }> = [];
  for (const anchor of anchors) {
    const file = await resolveFile(anchor);
    const { after, before } = file ? await textsOf(file) : { after: undefined, before: undefined };
    const sideText = side === "new" ? after : before;
    const lines = typeof sideText === "string" ? lineCount(sideText) : sideText === null ? 0 : undefined;
    const verdict = judge(anchor, file, side, lines);
    let symbol = "-";
    let change = "-";
    const sidePath = file ? (side === "old" ? (file.oldPath ?? file.path) : file.path) : anchor.path;
    if (file && typeof sideText === "string" && isSourcePath(sidePath)) {
      const list = declsOf(sidePath, sideText, `${side}:${sidePath}`);
      const decl = enclosing(list, anchor.start, anchor.end);
      symbol = decl ? matchKey(decl) : "file_level";
      if (decl) {
        const key = matchKey(liftTypeLevel(list, decl));
        change = changesOf(file, after, before).changes.find((c) => c.key === key)?.change ?? "-";
      }
    }
    rows.push({ anchor, verdict, symbol, change });
  }

  const invalid = rows.filter((r) => !r.verdict.ok);
  if (invalid.length > 0) process.exitCode = ANCHOR_INVALID_EXIT;

  const sourceWord = arg === "-" ? "-" : arg !== undefined ? shellWord(arg) : staged ? "--staged" : "";
  const again = (rest: string): string => `${arg === "-" ? "<diff> | " : ""}${["ts-axi anchor", sourceWord, rest, ...(flag(parsed, "--context") !== undefined ? [`--context ${context}`] : [])].filter(Boolean).join(" ")}`;
  const help: string[] = [];
  for (const r of invalid.slice(0, 3)) {
    if (r.verdict.reason.startsWith("removed line")) help.push(`Run \`${again(`${r.anchor.raw} --side old`)}\` - ${r.anchor.raw} is a removed line`);
    else if (r.verdict.reason.startsWith("added line")) help.push(`Run \`${again(r.anchor.raw)}\` - ${r.anchor.raw} is an added line on the new side`);
    else if (r.verdict.nearest) help.push(`Move ${r.anchor.raw} into ${r.verdict.nearest} or post it as a general comment`);
  }
  if (invalid.length > 0) {
    help.push(`exit 3 (ANCHOR_INVALID) - ${invalid.length} of ${rows.length} anchors cannot be commented; fix or drop them before posting`);
    if (extras.size === 0) help.push(`Run \`${again(`${invalid.map((r) => shellWord(r.anchor.raw)).join(" ")} --fields all`)}\` for in_diff, in_file, nearest, change and other_line`);
  } else {
    help.push("Every anchor is commentable - symbol is a stable key for each finding across pushes");
  }
  if (mismatched > 0) help.push("Check out the diff's head commit so symbol and in_file come from the code the diff describes");

  return out(
    block({
      ...(mismatched > 0 ? { warning: `${mismatched} files in the stdin diff do not match the working tree - symbol and in_file unknown there` } : {}),
      base: source.base,
      head: source.head,
      ...(source.kind !== "stdin" ? { context } : {}),
      side,
      anchors: rows.map(({ anchor, verdict, symbol, change }) => {
        const full: Record<string, unknown> = {
          anchor: anchor.raw,
          ok: verdict.ok,
          reason: verdict.reason,
          symbol,
          in_diff: verdict.inDiff,
          in_file: verdict.inFile ?? "-",
          nearest: verdict.nearest ?? "-",
          change,
          other_line: verdict.otherLine ?? "-",
        };
        return Object.fromEntries(Object.entries(full).filter(([k]) => !(ANCHOR_FIELDS as readonly string[]).includes(k) || extras.has(k)));
      }),
      invalid: invalid.length,
    }),
    helpBlock(help),
  );
}
