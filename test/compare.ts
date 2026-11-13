// One agent task done two ways - with ts-axi and with git grep plus file reads - and what each
// costs in tokens. Shared by test/integration/token-compare.test.ts and scripts/token-compare.ts.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import { estimateTokens } from "./tokens.js";

const execFileAsync = promisify(execFile);

export type TaskKind = "def" | "callers" | "refs" | "impact";

export interface Task {
  name: string;
  kind: TaskKind;
  /** `name` or `Owner.member`; for impact, the changed names an agent reads off the diff, comma-separated. */
  symbol: string;
  /** impact only: the git range (default: the working tree). */
  range?: string;
  /** AngularJS-style: also grep the kebab-case form and keep template and registration-string hits. */
  templates?: boolean;
}

export interface Recall {
  /** grep hits left after dropping comments and string-only mentions. */
  hits: number;
  /** hits ts-axi lists by file:line. */
  listed: number;
  /** hits not listed but covered by a `textual` / `templates` count. */
  counted: number;
  /** impact: hits not listed on lines the diff adds (impact reports References outside the change set). */
  inDiff: number;
  /** hits ts-axi neither lists nor counts, as `file:line: text`. */
  missing: string[];
  missingHits: Hit[];
}

export interface TaskResult {
  task: Task;
  axiTokens: number;
  grepTokens: number;
  ratio: number;
  recall: Recall;
  axiOutputs: string[];
  /** Raw grep hits, before the recall filter. */
  hits: Hit[];
  /** The commands each workflow ran, for the report. */
  axiCommands: string[];
  grepCommands: string[];
  /** Wall-clock time of each workflow's commands (CLI runs, git, file reads), ms. */
  axiMs: number;
  grepMs: number;
}

/** Assumed model round-trip per tool call, for the estimated task time (an assumption, not measured). */
export const TURN_MS = 3000;

/** Command time plus one model round-trip per tool call. */
export function taskMs(commandMs: number, calls: number): number {
  return commandMs + calls * TURN_MS;
}

const READ_CONTEXT = 40;
const TEMPLATE_FILE = /\.(?:html?|ejs|hbs|njk|pug)$/;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** Code an agent would open: sources and templates, not docs or lockfiles. */
const isCodeFile = (file: string) => SOURCE_FILE.test(file) || TEMPLATE_FILE.test(file);
const IMPORT_LINE = /^\s*(?:import\b|export\s+(?:\*|\{[^}]*\})\s+from\b)|^\s*(?:const|let|var)\s+\{[^}]*\}\s*=\s*require\(/;

async function git(dir: string, args: string[]): Promise<string> {
  try {
    // No optional index refresh: the analysed repo stays untouched.
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    return (await execFileAsync("git", args, { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    const e = error as { code?: number; stdout?: string };
    if (e.code === 1 && args[0] === "grep") return ""; // no match
    throw error;
  }
}

async function runCli(cli: string, dir: string, argv: string[]): Promise<string> {
  try {
    return (await execFileAsync("node", [cli, ...argv], { cwd: dir, maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? "";
  }
}

/** Drop what varies per run (timings, SHAs) so pinned numbers stay stable. */
function stable(stdout: string): string {
  return stdout.replace(/^elapsed_ms: \d+\n/gm, "").replace(/\b[0-9a-f]{40}\b/g, "<sha>");
}

const lastSegment = (symbol: string) => symbol.split(".").pop()!;
const ownerOf = (symbol: string) => (symbol.includes(".") ? symbol.split(".").slice(-2)[0] : undefined);
const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** POSIX ERE (git grep -E): `name` not followed by an identifier character. */
const ereEnd = "([^[:alnum:]_$]|$)";

// ---------------------------------------------------------------- ts-axi workflow

/** The commands a task needs, plus one followed hint where that is the normal next step. */
async function axiWorkflow(cli: string, dir: string, task: Task): Promise<{ outputs: string[]; commands: string[] }> {
  const first =
    task.kind === "impact" ? ["impact", ...(task.range ? [task.range] : [])] : [task.kind, task.symbol];
  const outputs = [await runCli(cli, dir, first)];
  const commands = [first.join(" ")];
  const hint = followedHint(task.kind, outputs[0]!);
  if (hint) {
    outputs.push(await runCli(cli, dir, hint));
    commands.push(hint.join(" "));
  }
  return { outputs, commands };
}

/** refs/callers: the `--limit` hint of a cut list, else `--grep` for textual matches; impact: `refs` on the riskiest row. */
function followedHint(kind: TaskKind, stdout: string): string[] | undefined {
  const hints = [...stdout.matchAll(/[Rr]un `ts-axi ([^`]+)`/g)].map((m) => m[1]!);
  const cut = /^truncated: true$/m.test(stdout) ? hints.find((h) => / --limit \d+/.test(h)) : undefined;
  const pick =
    kind === "impact" ? hints.find((h) => h.startsWith("refs ")) : kind === "def" ? undefined : cut ?? hints.find((h) => / --grep\b/.test(h));
  return pick?.split(" ");
}

interface Location {
  file: string;
  line: number;
}

/** Every file:line the outputs list, and the largest textual + template count any of them prints. */
function axiLocations(outputs: string[]): { listed: Set<string>; counted: number; perFile: Map<string, number> } {
  const listed = new Set<string>();
  // test_refs{file,count}: Test file rows collapsed to a count per file.
  const perFile = new Map<string, number>();
  let counted = 0;
  for (const stdout of outputs) {
    const fence = stdout.indexOf("\n---\n");
    const head = (fence === -1 ? stdout : stdout.slice(0, fence)).replace(/^warning: .*\n/gm, "");
    let data: Record<string, unknown>;
    try {
      data = decode(head, { strict: false }) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = (v: unknown) => {
      if (typeof v === "string" && /:\d+$/.test(v)) listed.add(v);
    };
    at(data["declared_at"]);
    if (typeof data["file"] === "string" && typeof data["line"] === "number") listed.add(`${data["file"]}:${data["line"]}`);
    for (const key of ["refs", "unresolved", "blind_spots", "matches", "changed"]) {
      const rows = data[key];
      if (!Array.isArray(rows)) continue;
      for (const row of rows as Record<string, unknown>[]) {
        at(row["at"]);
        if (row["file"] !== undefined && row["line"] !== undefined) listed.add(`${row["file"]}:${row["line"]}`);
      }
    }
    for (const row of Array.isArray(data["test_refs"]) ? (data["test_refs"] as Record<string, unknown>[]) : []) {
      perFile.set(String(row["file"]), Math.max(perFile.get(String(row["file"])) ?? 0, Number(row["count"])));
    }
    const n = (v: unknown) => (typeof v === "string" ? Number(/^(\d+)/.exec(v)?.[1] ?? 0) : 0);
    counted = Math.max(counted, n(data["textual"]) + n(data["templates"]));
  }
  return { listed, counted, perFile };
}

// ---------------------------------------------------------------- grep workflow

export interface Hit extends Location {
  text: string;
  /** What the grep matched, to find the occurrence again in the line. */
  needle: RegExp;
  /** impact: the diff adds this line, so it is part of the change set impact reports around. */
  inDiff?: boolean;
}

/** New-side `file:line` of every `+` line in a unified diff. */
function addedLines(diff: string): Set<string> {
  const added = new Set<string>();
  let file = "";
  let line = 0;
  for (const row of diff.split("\n")) {
    if (row.startsWith("+++ ")) file = row.slice(4).replace(/^b\//, "");
    else if (row.startsWith("@@")) line = Number(/\+(\d+)/.exec(row)?.[1] ?? 0);
    else if (row.startsWith("+")) added.add(`${file}:${line++}`);
    else if (row.startsWith(" ")) line++;
  }
  return added;
}

function parseGrep(stdout: string, needle: RegExp): Hit[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((row) => {
      const m = /^(.+?):(\d+):(.*)$/.exec(row);
      return m ? [{ file: m[1]!, line: Number(m[2]), text: m[3]!, needle }] : [];
    });
}

const wordRe = (name: string) => new RegExp(`(?<!\\w)${escapeRe(name)}(?!\\w)`, "g");
const DECL_KEYWORD = "(function|class|interface|type|enum|const|let|var)";

/** A line that declares `name` (not one that only uses it). */
function declares(text: string, name: string): boolean {
  const n = escapeRe(name);
  return [
    new RegExp(`\\b${DECL_KEYWORD}\\s+${n}\\b`),
    new RegExp(`^\\s*(?:(?:export|default|public|private|protected|static|async|readonly|get|set|abstract)\\s+)*\\*?${n}\\s*[(<]`),
    new RegExp(`(?:^|[\\s.{,])${n}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|\\w+\\s*=>)`),
  ].some((re) => re.test(text));
}

interface Read {
  file: string;
  from: number;
  to: number;
}

/** ±READ_CONTEXT lines around each hit, overlapping or touching windows merged. */
function readWindows(hits: Location[], lineCount: (file: string) => number): Read[] {
  const byFile = new Map<string, number[]>();
  for (const h of hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h.line]);
  const reads: Read[] = [];
  for (const [file, lines] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    let current: Read | undefined;
    for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
      const from = Math.max(1, line - READ_CONTEXT);
      const to = Math.min(lineCount(file), line + READ_CONTEXT);
      if (current && from <= current.to + 1) current.to = Math.max(current.to, to);
      else reads.push((current = { file, from, to }));
    }
  }
  return reads;
}

/** What an agent's Read tool returns: `cat -n` style line numbers. */
function renderRead(lines: string[], read: Read): string {
  let out = "";
  for (let n = read.from; n <= read.to; n++) out += `${String(n).padStart(6)}\t${lines[n - 1] ?? ""}\n`;
  return out;
}

/**
 * A careful agent without ts-axi: at most 3 `git grep -n` calls (the name plus one variant), then a
 * ±40-line read around each relevant match. A def stops at the declaring line; impact starts from `git diff`.
 */
async function grepWorkflow(dir: string, task: Task): Promise<{ text: string; hits: Hit[]; commands: string[] }> {
  const commands: string[] = [];
  let text = "";
  const grep = async (args: string[], needle: RegExp): Promise<Hit[]> => {
    if (commands.filter((c) => c.startsWith("git grep")).length >= 3) return [];
    commands.push(`git grep -n ${args.join(" ")}`);
    const stdout = await git(dir, ["grep", "-n", ...args]);
    text += stdout;
    return parseGrep(stdout, needle);
  };

  let hits: Hit[] = [];
  let toRead: Hit[];
  if (task.kind === "def") {
    const name = lastSegment(task.symbol);
    const owner = ownerOf(task.symbol);
    const declRe = (n: string) => `${DECL_KEYWORD}[[:space:]]+${n}${ereEnd}`;
    if (owner) {
      const owners = await grep(["-E", declRe(owner)], wordRe(owner));
      const files = [...new Set(owners.map((h) => h.file))];
      hits = files.length ? await grep(["-w", name, "--", ...files], wordRe(name)) : [];
    } else {
      hits = await grep(["-E", declRe(name)], wordRe(name));
    }
    hits = hits.filter((h) => declares(h.text, name));
    toRead = hits;
  } else {
    if (task.kind === "impact") {
      const range = task.range ? [task.range] : [];
      commands.push(`git diff ${range.join(" ")}`.trim());
      const diff = await git(dir, ["diff", ...range]);
      text += diff;
      // Every changed name in one call: `-w -e a -e b`.
      const names = task.symbol.split(",").map((s) => lastSegment(s.trim()));
      const needle = new RegExp(`(?<!\\w)(?:${names.map(escapeRe).join("|")})(?!\\w)`, "g");
      const added = addedLines(diff);
      for (const h of await grep(["-w", ...names.flatMap((n) => ["-e", n])], needle)) {
        hits.push({ ...h, inDiff: added.has(`${h.file}:${h.line}`) });
      }
    } else if (task.kind === "refs" && ownerOf(task.symbol)) {
      // A member: its `.name` accesses, not every local that shares the name.
      const name = lastSegment(task.symbol);
      hits.push(...(await grep(["-E", `\\.${name}${ereEnd}`], new RegExp(`\\.${escapeRe(name)}(?![\\w$])`, "g"))));
    } else {
      const name = lastSegment(task.symbol);
      hits.push(...(await grep(["-w", name], wordRe(name))));
      if (task.templates && kebab(name) !== name) hits.push(...(await grep(["-w", kebab(name)], wordRe(kebab(name)))));
    }
    toRead = hits;
  }

  const files = new Map<string, string[]>();
  const linesOf = (file: string) => {
    if (!files.has(file)) files.set(file, readFileSync(join(dir, file), "utf8").replace(/\n$/, "").split("\n"));
    return files.get(file)!;
  };
  for (const read of readWindows(toRead.filter((h) => isCodeFile(h.file)), (f) => linesOf(f).length)) {
    commands.push(`read ${read.file}:${read.from}-${read.to}`);
    text += renderRead(linesOf(read.file), read);
  }
  return { text, hits, commands };
}

// ---------------------------------------------------------------- recall filter

/** Character classes per position of one line: code, string or comment (no multi-line state). */
function classify(line: string): ("code" | "string" | "comment")[] {
  const out: ("code" | "string" | "comment")[] = [];
  if (/^\s*(\*|\/\*)/.test(line)) return [...line].map(() => "comment");
  let quote: string | undefined;
  const braces: number[] = []; // brace depth at each `${` inside a template literal
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      out.push("string");
      if (c === "\\") {
        out.push("string");
        i++;
      } else if (quote === "`" && c === "$" && line[i + 1] === "{") {
        out.push("string");
        i++;
        braces.push(depth);
        quote = undefined;
      } else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") return [...out, ...[...line.slice(i)].map(() => "comment" as const)];
    if (c === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      const stop = end === -1 ? line.length : end + 2;
      for (; i < stop; i++) out.push("comment");
      i--;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out.push("string");
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      if (braces.length && braces[braces.length - 1] === depth) {
        braces.pop();
        quote = "`";
        out.push("string");
        continue;
      }
      depth--;
    }
    out.push("code");
  }
  return out;
}

/** A hit whose every occurrence sits in a comment or a string is not a use (templates excepted). */
function isCodeHit(hit: Hit, task: Task): boolean {
  if (!isCodeFile(hit.file)) return false;
  if (TEMPLATE_FILE.test(hit.file)) return true;
  // An import or re-export names a function without calling it; any other non-call use stays a hit.
  if (task.kind === "callers" && IMPORT_LINE.test(hit.text)) return false;
  const classes = classify(hit.text);
  let found = false;
  for (const m of hit.text.matchAll(new RegExp(hit.needle.source, "g"))) {
    found = true;
    const at = classes[m.index] ?? "code";
    if (at === "code") return true;
    if (at === "string" && task.templates) return true; // registration strings
  }
  return !found;
}

// ---------------------------------------------------------------- one task

export async function compareTask(cli: string, dir: string, task: Task): Promise<TaskResult> {
  let started = performance.now();
  const axi = await axiWorkflow(cli, dir, task);
  const axiMs = Math.round(performance.now() - started);
  started = performance.now();
  const grep = await grepWorkflow(dir, task);
  const grepMs = Math.round(performance.now() - started);
  const axiTokens = axi.outputs.reduce((sum, o) => sum + estimateTokens(stable(o)), 0);
  const grepTokens = estimateTokens(grep.text);
  return {
    task,
    axiTokens,
    grepTokens,
    ratio: Math.round((axiTokens / grepTokens) * 1000) / 1000,
    recall: recallOf(axi.outputs, grep.hits, task),
    axiOutputs: axi.outputs,
    hits: grep.hits,
    axiCommands: axi.commands.map((c) => `ts-axi ${c}`),
    grepCommands: grep.commands,
    axiMs,
    grepMs,
  };
}

/** The declarations a task is about: `declared_at`, a def's location, impact's changed rows. */
export function targetsOf(axiOutputs: string[]): Set<string> {
  const targets = new Set<string>();
  for (const stdout of axiOutputs) {
    const decl = /^declared_at: "?([^"\n]+:\d+)"?$/m.exec(stdout)?.[1];
    if (decl) targets.add(decl);
    const file = /^file: (.+)$/m.exec(stdout)?.[1];
    const line = /^line: (\d+)$/m.exec(stdout)?.[1];
    if (file && line) targets.add(`${file}:${line}`);
    for (const m of stdout.matchAll(/^ {2}[^,\n]+,[^,\n]+,"([^"]+:\d+)",/gm)) targets.add(m[1]!);
  }
  return targets;
}

/** Which grep hits that are real uses the ts-axi outputs list, count, or miss. */
export function recallOf(axiOutputs: string[], grepHits: Hit[], task: Task): Recall {
  const { listed, counted, perFile } = axiLocations(axiOutputs);
  const seen = new Set<string>();
  const hits = grepHits.filter((h) => {
    const key = `${h.file}:${h.line}`;
    if (seen.has(key) || !isCodeHit(h, task)) return false;
    seen.add(key);
    return true;
  });
  const notListed = hits.filter((h) => !listed.has(`${h.file}:${h.line}`));
  const listedHits = hits.length - notListed.length;
  // A per-file count covers that many of the file's hits.
  const fileBudget = new Map(perFile);
  const byFile = notListed.filter((h) => {
    const left = fileBudget.get(h.file) ?? 0;
    if (h.inDiff || left === 0) return false;
    fileBudget.set(h.file, left - 1);
    return true;
  });
  const unlisted = notListed.filter((h) => !h.inDiff && !byFile.includes(h));
  // A count covers what it counts beyond the rows already listed, never more.
  const byCount = unlisted.length <= Math.max(0, counted - listedHits) ? unlisted.length : 0;
  const missingHits = byCount ? [] : unlisted;
  return {
    hits: hits.length,
    listed: listedHits,
    counted: byCount + byFile.length,
    inDiff: notListed.filter((h) => h.inDiff).length,
    missing: missingHits.map((h) => `${h.file}:${h.line}: ${h.text.trim()}`),
    missingHits,
  };
}

export function recallLabel(r: Recall): string {
  if (r.hits === 0) return "n/a (0 hits)";
  const pct = Math.floor(((r.hits - r.missing.length) / r.hits) * 100);
  const extra = [r.counted && `${r.counted} by count`, r.inDiff && `${r.inDiff} in the diff`].filter(Boolean);
  return `${pct}% (${r.hits - r.missing.length}/${r.hits}${extra.length ? `, ${extra.join(", ")}` : ""})`;
}

/** Markdown table; `repo` labels each row. */
export function reportTable(rows: { repo: string; result: TaskResult }[]): string {
  const lines = ["| task | repo | ts-axi tokens | grep tokens | ratio | recall |", "| --- | --- | ---: | ---: | ---: | --- |"];
  for (const { repo, result: r } of rows) {
    lines.push(`| ${r.task.name} | ${repo} | ${r.axiTokens} | ${r.grepTokens} | ${r.ratio.toFixed(2)} | ${recallLabel(r.recall)} |`);
  }
  return `${lines.join("\n")}\n`;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)} s`;

/** Markdown table of tool calls and time: measured command time, and the task time estimated at TURN_MS per call. */
export function speedTable(rows: { repo: string; result: TaskResult }[]): string {
  const lines = [
    "| task | repo | ts-axi calls | grep calls | ts-axi command time | grep command time | est. task time ts-axi | est. task time grep |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const { repo, result: r } of rows) {
    const a = r.axiCommands.length;
    const g = r.grepCommands.length;
    lines.push(`| ${r.task.name} | ${repo} | ${a} | ${g} | ${seconds(r.axiMs)} | ${seconds(r.grepMs)} | ${seconds(taskMs(r.axiMs, a))} | ${seconds(taskMs(r.grepMs, g))} |`);
  }
  return `${lines.join("\n")}\n`;
}
