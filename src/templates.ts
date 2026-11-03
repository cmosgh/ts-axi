// Template usages of AngularJS-style registrations: directives and components as kebab-case
// elements/attributes, their bindings as attributes, controllers in `ng-controller`, filters
// after `|`. One regex pass per template line, no HTML parsing.
import { readFileSync } from "node:fs";
import type { Declaration } from "./symbols.js";
import { listFiles, toRel } from "./walk.js";

export const TEMPLATE_EXTENSIONS = [".html", ".htm", ".ejs", ".hbs", ".njk", ".pug"] as const;

export function isTemplatePath(path: string): boolean {
  return TEMPLATE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** `wapSelect` → `wap-select`. */
export function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").toLowerCase();
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface TemplateTarget {
  /** Qualified name of the Declaration. */
  symbol: string;
  /** Matches one usage on a line. */
  pattern: RegExp;
  /** For a binding: the owner's pattern, which must open the tag the attribute sits in. */
  owner?: RegExp;
}

/** Opening tag `<wap-select` or attribute `wap-select` / `data-wap-select` / `x-wap-select`. */
function elementOrAttribute(name: string): RegExp {
  return new RegExp(`(?:<|[\\s"'])(?:data-|x-)?${escape(kebab(name))}(?![\\w-])`, "g");
}

/** A Declaration's template form; undefined when templates cannot name it. */
export function templateTarget(decl: Declaration, fileDecls: readonly Declaration[]): TemplateTarget | undefined {
  const isComponent = (d: Declaration | undefined): boolean => d !== undefined && d.nameless === true && d.signature.startsWith("component ");
  if (decl.nameless && (decl.parentName === "directive" || isComponent(decl))) return { symbol: decl.qualifiedName, pattern: elementOrAttribute(decl.name) };
  if (decl.nameless && decl.parentName === "controller") {
    return { symbol: decl.qualifiedName, pattern: new RegExp(`ng-controller\\s*=\\s*["']\\s*${escape(decl.name)}(?![\\w$])`, "g") };
  }
  if (decl.nameless && decl.parentName === "filter") return { symbol: decl.qualifiedName, pattern: new RegExp(`(?<!\\|)\\|\\s*${escape(decl.name)}(?![\\w$])`, "g") };
  if (decl.kind === "property" && decl.parentName !== undefined) {
    const owner = fileDecls.find((d) => d.qualifiedName === decl.parentName && d.parentName !== decl.parentName);
    if (owner && owner.nameless && (owner.parentName === "directive" || isComponent(owner))) {
      return {
        symbol: decl.qualifiedName,
        pattern: new RegExp(`\\s(?:data-|x-)?${escape(kebab(decl.name))}(?=[\\s=>/])`, "g"),
        owner: elementOrAttribute(owner.name),
      };
    }
  }
  return undefined;
}

export interface TemplateFile {
  rel: string;
  text: string;
}

/** Template files of the repo root (git listing, else the bounded walk). */
export function loadTemplates(root: string): TemplateFile[] {
  const files: TemplateFile[] = [];
  for (const abs of listFiles(root, isTemplatePath).files) {
    try {
      files.push({ rel: toRel(root, abs), text: readFileSync(abs, "utf8") });
    } catch {
      // unreadable: skipped
    }
  }
  return files;
}

export interface TemplateUsage {
  file: string;
  line: number;
  col: number;
}

/** Usages of `target` in one template text: at most one per line. */
export function usagesIn(text: string, target: TemplateTarget): Array<{ line: number; col: number }> {
  const result: Array<{ line: number; col: number }> = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  let lastLine = 0;
  for (const m of text.matchAll(target.pattern)) {
    // Skip the delimiter the pattern consumed (`<`, whitespace, quote, `|`).
    const offset = (m.index ?? 0) + (/^[<\s"'|]/.test(m[0]) ? 1 : 0);
    if (target.owner) {
      // The attribute counts only inside a tag opened by (or carrying) the owner directive.
      const tagStart = text.lastIndexOf("<", offset);
      if (tagStart < 0) continue;
      const tag = text.slice(tagStart, offset);
      target.owner.lastIndex = 0;
      if (tag.includes(">") || !target.owner.test(tag)) continue;
    }
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    const line = lo + 1;
    if (line === lastLine) continue;
    lastLine = line;
    result.push({ line, col: offset - lineStarts[lo]! + 1 });
  }
  return result;
}

export function templateUsages(files: readonly TemplateFile[], target: TemplateTarget): TemplateUsage[] {
  return files.flatMap((f) => usagesIn(f.text, target).map((u) => ({ file: f.rel, ...u })));
}

export function templatesLine(usages: ReadonlyArray<{ file: string }>): string {
  return `${usages.length} usages in ${new Set(usages.map((u) => u.file)).size} files`;
}
