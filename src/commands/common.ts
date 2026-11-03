// Plumbing shared by def / refs / callers / outline: flags, project opening,
// target resolution and code rendering.
import { existsSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { enumFlag, flag, flags, type FlagSpec, type ParsedArgs, bool } from "../args.js";
import { usageError } from "../errors.js";
import { hasGlobMagic, matchesGlob } from "../glob.js";
import { openProject, type ProjectContext, type SyntacticIndex } from "../project.js";
import { loadSettings, type Settings } from "../settings.js";
import { byDepthThenPath } from "../walk.js";
import {
  clip,
  didYouMean,
  groupSymbols,
  KINDS,
  kindOf,
  signatureOf,
  type Declaration,
  type Kind,
  type SymbolGroup,
  type Target,
} from "../symbols.js";

export const BODY_LINES = 60;
export const CONTEXT_MAX = 100;

export const TARGET_FLAGS: readonly FlagSpec[] = [
  { name: "--kind" },
  { name: "--in", repeatable: true },
  { name: "--exported", boolean: true },
  { name: "--fuzzy", boolean: true },
  { name: "-P" },
];

export interface TargetFilters {
  kind?: Kind;
  in: string[];
  exported: boolean;
  fuzzy: boolean;
}

export function readFilters(parsed: ParsedArgs, extraKinds: readonly string[] = []): TargetFilters & { rawKind?: string } {
  const raw = flag(parsed, "--kind");
  const kind = raw === undefined ? undefined : enumFlag(parsed, "--kind", [...KINDS, ...extraKinds], KINDS[0]);
  return {
    ...(kind !== undefined && (KINDS as readonly string[]).includes(kind) ? { kind: kind as Kind } : {}),
    ...(kind !== undefined ? { rawKind: kind } : {}),
    in: flags(parsed, "--in"),
    exported: bool(parsed, "--exported"),
    fuzzy: bool(parsed, "--fuzzy"),
  };
}

/** Flags reproduced in follow-up hints so the next command resolves the same way. */
export function filterSuffix(f: TargetFilters, project?: string): string {
  return [
    f.kind ? ` --kind ${f.kind}` : "",
    ...f.in.map((g) => ` --in ${g}`),
    f.exported ? " --exported" : "",
    f.fuzzy ? " --fuzzy" : "",
    project ? ` -P ${project}` : "",
  ].join("");
}

export interface Opened extends ProjectContext {
  settings: Settings;
}

/** Settings + repo root + tsconfig + syntactic index. `startDir` is the target file's directory for positions. */
export function open(cwd: string, parsed: ParsedArgs, startDir?: string): Opened {
  const override = flag(parsed, "-P");
  const settings = loadSettings(cwd, {
    testGlobs: flags(parsed, "--test-glob"),
    ...(override ? { project: override } : {}),
  });
  const ctx = openProject(cwd, {
    ...(startDir ? { startDir } : {}),
    ...(override ? { override } : {}),
    ...(settings.project && !override ? { settingsProject: settings.project, settingsRoot: settings.root } : {}),
  });
  return { ...ctx, settings };
}

/** `--in` globs are given relative to cwd; the index matches repo-root-relative paths. */
function rootGlob(ctx: ProjectContext, glob: string): string {
  const prefix = relative(ctx.root, ctx.cwd).split(sep).join("/");
  const clean = glob.replace(/^\.\//, "");
  return prefix && !prefix.startsWith("..") ? posix.join(prefix, clean) : clean;
}

export function applyFilters(ctx: ProjectContext, decls: Declaration[], f: TargetFilters): Declaration[] {
  const globs = f.in.map((g) => rootGlob(ctx, g));
  return decls.filter(
    (d) =>
      (f.kind === undefined || d.kind === f.kind) &&
      (!f.exported || d.exported) &&
      (globs.length === 0 || globs.some((g) => matchesGlob(d.file, g))),
  );
}

export function resolveNameTarget(
  ctx: ProjectContext,
  target: Extract<Target, { kind: "name" }>,
  f: TargetFilters,
): SymbolGroup[] {
  const found = ctx.index.findDeclarations({
    name: target.name,
    ...(target.member !== undefined ? { member: target.member } : {}),
    fuzzy: f.fuzzy,
  });
  // Shallowest path first: the canonical copy before nested duplicates.
  return groupSymbols(applyFilters(ctx, found, f)).sort(
    (a, b) => byDepthThenPath(a.primary.file, b.primary.file) || a.decls[0]!.nameLine - b.decls[0]!.nameLine,
  );
}

/** `tsconfig: x (n referenced configs)` when a references-only tsconfig was expanded. */
export function projectFields(ctx: ProjectContext): Record<string, unknown> {
  const { tsconfig, referenced } = ctx.index.project;
  if (!tsconfig || referenced === undefined) return {};
  return { tsconfig: `${relative(ctx.cwd, tsconfig).split(sep).join("/")} (${referenced} referenced configs)` };
}

export function suggestions(ctx: ProjectContext, target: Extract<Target, { kind: "name" }>): string[] {
  const names = [...ctx.index.allNames()].filter((n) => (target.member === undefined ? !n.includes(".") : n.includes(".")));
  return didYouMean(target.member === undefined ? target.name : `${target.name}.${target.member}`, names);
}

export function targetLabel(target: Target): string {
  if (target.kind === "name") return target.member ? `${target.name}.${target.member}` : target.name;
  return `${target.file}:${target.line}${target.col ? `:${target.col}` : ""}`;
}

/** `file:line` of a group's first Declaration, the canonical position hint. */
export function positionOf(group: SymbolGroup): string {
  const d = group.decls[0]!;
  return `${d.file}:${d.nameLine}`;
}

/** Ambiguity lists stop here; the narrowing hints cover the rest. */
export const MATCH_ROWS = 20;

/** `matches` (first MATCH_ROWS, shallowest first) plus `matches_total` / `truncated` past that. */
export function matchRows(groups: SymbolGroup[]): Record<string, unknown> {
  const rows = groups.slice(0, MATCH_ROWS).map((g) => ({
    file: g.primary.file,
    line: g.decls[0]!.nameLine,
    kind: g.primary.kind,
    exported: g.primary.exported,
    signature: g.decls[0]!.signature,
  }));
  return { matches: rows, ...(groups.length > MATCH_ROWS ? { matches_total: groups.length, truncated: true } : {}) };
}

function countBy<T>(items: readonly T[], key: (item: T) => string | undefined): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Longest common directory of `files` ('' when they share none). */
function commonDir(files: readonly string[]): string {
  const split = files.map((f) => posix.dirname(f).split("/").filter((p) => p !== "" && p !== "."));
  const first = split[0] ?? [];
  let n = 0;
  while (n < first.length && split.every((parts) => parts[n] === first[n])) n++;
  return first.slice(0, n).join("/");
}

const IDENT_PART = /^[A-Za-z_$][\w$]*$/;

/** Root-relative path → the form `--in` expects (relative to cwd). */
function cwdGlob(ctx: ProjectContext, rootRel: string): string {
  const prefix = relative(ctx.root, ctx.cwd).split(sep).join("/");
  if (!prefix || prefix.startsWith("..")) return rootRel;
  return posix.relative(prefix, rootRel) || ".";
}

/** Concrete hints that narrow an ambiguous name, computed from the matches themselves. */
export function narrowHints(ctx: ProjectContext, command: string, groups: SymbolGroup[], f: TargetFilters, label: string, target?: Extract<Target, { kind: "name" }>): string[] {
  const total = groups.length;
  const hints = groups.slice(0, 2).map((g) => `Run \`ts-axi ${command} ${positionOf(g)}\` for the one in ${g.primary.file}`);
  const files = groups.map((g) => g.primary.file);
  // --in: the subtrees right below the common directory, largest first.
  const prefix = commonDir(files);
  const below = countBy(files, (file) => {
    const rest = (prefix ? file.slice(prefix.length + 1) : file).split("/");
    return rest.length > 1 ? posix.join(prefix, rest[0]!) : file;
  });
  if (below.length > 1) {
    for (const [dir, n] of below.slice(0, 2)) hints.push(`Run \`ts-axi ${command} ${label} --in ${cwdGlob(ctx, dir)}\` to keep ${n} of ${total}`);
  } else if (prefix) {
    hints.push(`Run \`ts-axi ${command} ${label} --in ${cwdGlob(ctx, prefix)}\` - all ${total} are below ${prefix}`);
  }
  if (!f.kind) {
    const kinds = countBy(groups, (g) => g.primary.kind);
    if (kinds.length > 1) for (const [kind, n] of kinds.slice(0, 3)) hints.push(`Run \`ts-axi ${command} ${label} --kind ${kind}\` to keep ${n} of ${total}`);
  }
  if (target && target.member === undefined) {
    const parents = countBy(groups, (g) => g.primary.parentName?.split(".").pop());
    const distinct = parents.length > 1 || (parents.length === 1 && groups.some((g) => g.primary.parentName === undefined));
    if (distinct) {
      for (const [parent, n] of parents.filter(([p]) => IDENT_PART.test(p)).slice(0, 2)) {
        hints.push(`Run \`ts-axi ${command} ${parent}.${target.name}${filterSuffixOf(label, target)}\` to keep ${n} of ${total}`);
      }
    }
  }
  const exported = groups.filter((g) => g.primary.exported).length;
  if (!f.exported && exported > 0 && exported < total) {
    hints.push(`Run \`ts-axi ${command} ${label} --exported\` to keep ${exported} of ${total}`);
  }
  return hints;
}

/** The flags part of a hint label (`label` = target + filter suffix). */
function filterSuffixOf(label: string, target: Extract<Target, { kind: "name" }>): string {
  const bare = target.member ? `${target.name}.${target.member}` : target.name;
  return label.startsWith(bare) ? label.slice(bare.length) : "";
}

// --- Position targets ---

export type PositionResolution =
  | { kind: "decl"; decl: Declaration; abs: string }
  | { kind: "ident"; abs: string; pos: number; name: string }
  | { kind: "ambiguous"; abs: string; file: string; candidates: Array<{ name: string; line: number; col: number }> }
  | { kind: "none"; abs: string; file: string; reason: string };

export function resolvePositionFile(cwd: string, file: string): string {
  const abs = resolve(cwd, file);
  if (!existsSync(abs)) {
    throw usageError(`file not found: ${file}`, ["paths are relative to the current directory"]);
  }
  return abs;
}

export function positionStartDir(cwd: string, target: Target): string | undefined {
  return target.kind === "position" ? dirname(resolvePositionFile(cwd, target.file)) : undefined;
}

function identifiers(node: ts.Node, sf: ts.SourceFile, outIds: Array<ts.Identifier | ts.PrivateIdentifier>): void {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
    outIds.push(node);
    return;
  }
  ts.forEachChild(node, (child) => identifiers(child, sf, outIds));
}

function isDeclarationName(id: ts.Node): boolean {
  const parent = id.parent as ts.Node & { name?: ts.Node };
  return parent !== undefined && parent.name === id && (kindOf(parent) !== undefined || ts.isParameter(parent) || ts.isBindingElement(parent));
}

/** The identifier a `path:line[:col]` target points at (see PLAN.md Targets). */
export function resolvePosition(index: SyntacticIndex, cwd: string, target: Extract<Target, { kind: "position" }>): PositionResolution {
  const abs = resolvePositionFile(cwd, target.file);
  const file = index.rel(abs);
  const sf = index.sourceFile(abs);
  if (!sf) throw usageError(`cannot read ${target.file}`);
  const lineCount = sf.getLineStarts().length;
  if (target.line > lineCount) {
    throw usageError(`line ${target.line} is past the end of ${file} (${lineCount} lines)`);
  }
  const lineStart = sf.getPositionOfLineAndCharacter(target.line - 1, 0);
  const lineEnd = target.line < lineCount ? sf.getPositionOfLineAndCharacter(target.line, 0) : sf.text.length;
  const ids: Array<ts.Identifier | ts.PrivateIdentifier> = [];
  identifiers(sf, sf, ids);
  const onLine = ids.filter((id) => {
    const start = id.getStart(sf);
    return start >= lineStart && start < lineEnd;
  });
  const decls = index.declarations(abs);
  const declFor = (id: ts.Node): Declaration | undefined => decls.find((d) => d.namePos === id.getStart(sf));
  const pick = (id: ts.Identifier | ts.PrivateIdentifier): PositionResolution => {
    const decl = declFor(id);
    return decl ? { kind: "decl", decl, abs } : { kind: "ident", abs, pos: id.getStart(sf), name: id.text };
  };

  if (target.col !== undefined) {
    const offset = lineStart + target.col - 1;
    const hit = onLine.find((id) => id.getStart(sf) <= offset && offset <= id.end) ?? onLine.find((id) => id.getStart(sf) >= offset);
    return hit ? pick(hit) : { kind: "none", abs, file, reason: `no identifier at ${file}:${target.line}:${target.col}` };
  }
  // A string-registered name has no identifier: its line stands for it.
  const nameless = decls.find((d) => d.nameless && d.nameLine === target.line);
  if (nameless) return { kind: "decl", decl: nameless, abs };
  if (onLine.length === 0) return { kind: "none", abs, file, reason: `no identifier on ${file}:${target.line}` };
  const constructorDecl = decls.find((d) => d.nameLine === target.line && d.name === "constructor");
  const declared = onLine.find((id) => declFor(id)) ?? onLine.find(isDeclarationName);
  if (declared) return pick(declared);
  if (constructorDecl) return { kind: "decl", decl: constructorDecl, abs };
  const distinct = new Map<string, ts.Identifier | ts.PrivateIdentifier>();
  for (const id of onLine) if (!distinct.has(id.text)) distinct.set(id.text, id);
  if (distinct.size === 1) return pick(onLine[0]!);
  return {
    kind: "ambiguous",
    abs,
    file,
    candidates: [...distinct.values()].map((id) => ({
      name: id.text,
      line: target.line,
      col: id.getStart(sf) - lineStart + 1,
    })),
  };
}

/** A Declaration for an arbitrary declaration name position (locals, parameters) not in the index. */
export function declarationAt(index: SyntacticIndex, abs: string, pos: number, fallbackKind: Kind): Declaration | undefined {
  const known = index.declarations(abs).find((d) => d.namePos === pos);
  if (known) return known;
  const sf = index.sourceFile(abs);
  if (!sf) return undefined;
  const ids: ts.Node[] = [];
  identifiers(sf, sf, ids as Array<ts.Identifier | ts.PrivateIdentifier>);
  const id = ids.find((n) => n.getStart(sf) === pos);
  if (!id) return undefined;
  const node: ts.Node = id.parent ?? id;
  // Declarator for kind/signature; the statement start for the body range.
  const startNode = ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent.parent) ? node.parent.parent : node;
  const start = sf.getLineAndCharacterOfPosition(startNode.getStart(sf));
  const name = (id as ts.Identifier).text;
  return {
    file: index.rel(abs),
    line: start.line + 1,
    col: start.character + 1,
    endLine: sf.getLineAndCharacterOfPosition(startNode.end).line + 1,
    kind: kindOf(node) ?? fallbackKind,
    name,
    qualifiedName: name,
    exported: false,
    signature: signatureOf(node, sf),
    namePos: pos,
    nameLine: sf.getLineAndCharacterOfPosition(pos).line + 1,
    hasBody: true,
  };
}

// --- Rendering ---

/** `  42 | code` lines for [from, to] (1-based, inclusive), capped at `max` with a total marker. */
export function numberedLines(text: string, from: number, to: number, max: number | undefined): string {
  const lines = text.split(/\r?\n/);
  const last = Math.min(to, lines.length);
  const total = last - from + 1;
  const shownLast = max !== undefined && total > max ? from + max - 1 : last;
  const width = Math.max(4, String(shownLast).length + 2);
  const body = [];
  for (let n = from; n <= shownLast; n++) body.push(`${String(n).padStart(width)} | ${lines[n - 1] ?? ""}`.trimEnd());
  if (shownLast < last) body.push(`... (truncated, ${total} lines total)`);
  return body.join("\n");
}

/** One source line as a context cell: trimmed, at most 100 chars, windowed around `col`. */
export function contextOf(lineText: string, col: number): string {
  const trimmed = lineText.trim();
  if (trimmed.length <= CONTEXT_MAX) return trimmed;
  const lead = lineText.length - lineText.trimStart().length;
  const at = Math.max(0, col - 1 - lead);
  const room = CONTEXT_MAX - 6;
  const start = Math.max(0, Math.min(at - 30, trimmed.length - room));
  const slice = trimmed.slice(start, start + room).trim();
  return `${start > 0 ? "..." : ""}${slice}${start + room < trimmed.length ? "..." : ""}`;
}

export function lineOf(text: string | undefined, line: number): string {
  if (text === undefined) return "";
  const lines = text.split(/\r?\n/);
  return lines[line - 1] ?? "";
}

export { clip, hasGlobMagic };
