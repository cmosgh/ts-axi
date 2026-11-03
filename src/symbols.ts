// Domain model shared by both engine paths: Declarations, kinds, Signatures,
// export rules, target parsing and name suggestions. Syntax only - no checker.
import ts from "typescript";
import { usageError } from "./errors.js";

export const KINDS = [
  "function",
  "class",
  "method",
  "property",
  "variable",
  "interface",
  "type",
  "enum",
  "enum-member",
  "namespace",
] as const;
export type Kind = (typeof KINDS)[number];

export interface Declaration {
  /** Repo-root-relative path with `/`. */
  file: string;
  /** 1-based, at the declaration start (modifiers included, JSDoc excluded). */
  line: number;
  col: number;
  endLine: number;
  kind: Kind;
  name: string;
  /** `User.save` for members, `NS.fn` for namespace members, else `name`. */
  qualifiedName: string;
  exported: boolean;
  signature: string;
  parentName?: string;
  /** Offset of the name identifier: the position to ask the LanguageService about. */
  namePos: number;
  /** Line of the name identifier (1-based). */
  nameLine: number;
  /** Has a body / implementation (false for overload signatures). */
  hasBody: boolean;
}

export const SIGNATURE_MAX = 160;

const FUNCTION_LIKE: ReadonlySet<Kind> = new Set(["function", "method"]);

export function isFunctionLike(kind: Kind): boolean {
  return FUNCTION_LIKE.has(kind);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false) : false;
}

function isFunctionInitializer(init: ts.Expression | undefined): init is ts.ArrowFunction | ts.FunctionExpression {
  return init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
}

/** Map an AST node to a Declaration kind; undefined for nodes that are not Declarations. */
export function kindOf(node: ts.Node): Kind | undefined {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
      return "function";
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
      return "class";
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
    case ts.SyntaxKind.Constructor:
      return "method";
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.PropertySignature:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return "property";
    case ts.SyntaxKind.VariableDeclaration:
      return isFunctionInitializer((node as ts.VariableDeclaration).initializer) ? "function" : "variable";
    case ts.SyntaxKind.InterfaceDeclaration:
      return "interface";
    case ts.SyntaxKind.TypeAliasDeclaration:
      return "type";
    case ts.SyntaxKind.EnumDeclaration:
      return "enum";
    case ts.SyntaxKind.EnumMember:
      return "enum-member";
    case ts.SyntaxKind.ModuleDeclaration:
      return "namespace";
    default:
      return undefined;
  }
}

/** Map a LanguageService ScriptElementKind to a Declaration kind. */
export function kindFromScriptElement(kind: string): Kind {
  switch (kind) {
    case "function":
    case "local function":
      return "function";
    case "class":
    case "local class":
      return "class";
    case "method":
    case "constructor":
    case "construct":
    case "call":
      return "method";
    case "property":
    case "getter":
    case "setter":
    case "accessor":
      return "property";
    case "interface":
      return "interface";
    case "type":
    case "type parameter":
      return "type";
    case "enum":
      return "enum";
    case "enum member":
      return "enum-member";
    case "module":
      return "namespace";
    default:
      return "variable";
  }
}

// --- Signatures ---

function leafTokens(node: ts.Node, sf: ts.SourceFile, outTokens: ts.Node[]): void {
  if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
  const children = node.getChildren(sf);
  if (children.length === 0) {
    if (node.kind !== ts.SyntaxKind.EndOfFileToken && node.end > node.pos) outTokens.push(node);
    return;
  }
  for (const child of children) leafTokens(child, sf, outTokens);
}

const NO_SPACE_AFTER = new Set(["(", "[", "<"]);
const NO_SPACE_BEFORE = new Set([")", "]", ",", ";", ">"]);

/**
 * Normalised source text of `[start, end)` within `node`: tokens re-joined,
 * comments dropped, whitespace collapsed, trailing commas before a closing bracket removed.
 */
export function tokenText(node: ts.Node, sf: ts.SourceFile, start: number, end: number): string {
  const tokens: ts.Node[] = [];
  leafTokens(node, sf, tokens);
  const parts: string[] = [];
  let prevEnd = -1;
  for (const token of tokens) {
    const tokStart = token.getStart(sf);
    if (tokStart < start || token.end > end) continue;
    const text = sf.text.slice(tokStart, token.end);
    const prev = parts[parts.length - 1];
    if (prev !== undefined) {
      if ((text === ")" || text === "]" || text === "}") && prev === ",") parts.pop();
      const last = parts[parts.length - 1];
      const gap = prevEnd >= 0 && tokStart > prevEnd;
      if (gap && last !== undefined && !NO_SPACE_AFTER.has(last) && !NO_SPACE_BEFORE.has(text)) parts.push(" ");
    }
    parts.push(text);
    prevEnd = token.end;
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

export function clip(text: string, max: number = SIGNATURE_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

function bodyOf(node: ts.Node): ts.Node | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return node.body;
  }
  if (ts.isModuleDeclaration(node)) return node.body;
  return undefined;
}

function openBrace(node: ts.Node, sf: ts.SourceFile): number | undefined {
  return node.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.OpenBraceToken)?.getStart(sf);
}

/** Uncapped Signature text; `signatureOf` clips it for display. */
export function fullSignatureOf(node: ts.Node, sf: ts.SourceFile): string {
  if (ts.isVariableDeclaration(node)) {
    const list = node.parent;
    const statement = list.parent;
    const head = ts.isVariableDeclarationList(list) && ts.isVariableStatement(statement)
      ? tokenText(statement, sf, statement.getStart(sf), list.declarations[0]!.getStart(sf))
      : "";
    const fn = isFunctionInitializer(node.initializer) ? node.initializer : undefined;
    const end = fn ? fn.body.getStart(sf) : node.end;
    let text = tokenText(node, sf, node.getStart(sf), end);
    if (fn && ts.isArrowFunction(fn)) text = text.replace(/\s*=>$/, " =>");
    return `${head} ${text}`.trim();
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return tokenText(node, sf, node.getStart(sf), openBrace(node, sf) ?? node.end);
  }
  if (ts.isModuleDeclaration(node)) {
    return tokenText(node, sf, node.getStart(sf), node.body?.getStart(sf) ?? node.end);
  }
  const body = bodyOf(node);
  const end = body ? body.getStart(sf) : node.end;
  return tokenText(node, sf, node.getStart(sf), end).replace(/;$/, "");
}

/** Declaration text without body, comments stripped, whitespace normalised, clipped. */
export function signatureOf(node: ts.Node, sf: ts.SourceFile): string {
  return clip(fullSignatureOf(node, sf));
}

// --- Export detection ---

/** Names exported from a file through `export { a, b as c }` or `export default a`. */
export function localExportNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const el of statement.exportClause.elements) names.add((el.propertyName ?? el.name).text);
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      names.add(statement.expression.text);
    }
  }
  return names;
}

function isTopLevelExported(statement: ts.Node, name: string, local: Set<string>): boolean {
  return hasModifier(statement, ts.SyntaxKind.ExportKeyword) || local.has(name);
}

function isPrivateMember(member: ts.ClassElement): boolean {
  return (
    hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
    (member.name !== undefined && ts.isPrivateIdentifier(member.name))
  );
}

// --- Declarations of one file ---

function nameText(name: ts.Node | undefined, sf: ts.SourceFile): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sf);
}

/**
 * Top-level Declarations of a file in source order, with class, interface and
 * enum members and namespace members following their parent.
 */
export function collectDeclarations(sf: ts.SourceFile, file: string): Declaration[] {
  const result: Declaration[] = [];
  const local = localExportNames(sf);

  const add = (
    node: ts.Node,
    nameNode: ts.Node | undefined,
    name: string,
    exported: boolean,
    parent?: string,
  ): void => {
    const kind = kindOf(node);
    if (!kind) return;
    const startNode = ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) && node.parent.declarations[0] === node
      ? node.parent.parent
      : node;
    const start = startNode.getStart(sf);
    const startLc = sf.getLineAndCharacterOfPosition(start);
    const namePos = nameNode ? nameNode.getStart(sf) : start;
    const body = bodyOf(ts.isVariableDeclaration(node) && isFunctionInitializer(node.initializer) ? node.initializer : node);
    result.push({
      file,
      line: startLc.line + 1,
      col: startLc.character + 1,
      endLine: sf.getLineAndCharacterOfPosition(node.end).line + 1,
      kind,
      name,
      qualifiedName: parent ? `${parent}.${name}` : name,
      exported,
      signature: signatureOf(node, sf),
      ...(parent ? { parentName: parent } : {}),
      namePos,
      nameLine: sf.getLineAndCharacterOfPosition(namePos).line + 1,
      hasBody:
        body !== undefined ||
        !(ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)),
    });
  };

  const visitStatements = (statements: readonly ts.Statement[], parent: string | undefined, parentExported: boolean): void => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const exported = parent ? parentExported && hasModifier(statement, ts.SyntaxKind.ExportKeyword) : isTopLevelExported(statement, decl.name.text, local);
          add(decl, decl.name, decl.name.text, exported, parent);
        }
        continue;
      }
      if (
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)
      ) {
        const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
        const name = nameText(statement.name, sf) ?? (isDefault ? "default" : undefined);
        if (!name) continue;
        const exported = parent
          ? parentExported && hasModifier(statement, ts.SyntaxKind.ExportKeyword)
          : isTopLevelExported(statement, name, local);
        add(statement, statement.name, name, exported, parent);
        const qualified = parent ? `${parent}.${name}` : name;
        if (ts.isClassDeclaration(statement)) {
          for (const member of statement.members) {
            if (ts.isSemicolonClassElement(member) || ts.isClassStaticBlockDeclaration(member) || ts.isIndexSignatureDeclaration(member)) continue;
            const memberName = ts.isConstructorDeclaration(member) ? "constructor" : nameText(member.name, sf);
            if (!memberName) continue;
            const nameNode = ts.isConstructorDeclaration(member)
              ? member.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.ConstructorKeyword)
              : member.name;
            add(member, nameNode, memberName, exported && !isPrivateMember(member), qualified);
          }
        } else if (ts.isInterfaceDeclaration(statement)) {
          for (const member of statement.members) {
            const memberName = nameText(member.name, sf);
            if (memberName) add(member, member.name, memberName, exported, qualified);
          }
        } else if (ts.isEnumDeclaration(statement)) {
          for (const member of statement.members) {
            const memberName = nameText(member.name, sf);
            if (memberName) add(member, member.name, memberName, exported, qualified);
          }
        } else if (ts.isModuleDeclaration(statement) && statement.body && ts.isModuleBlock(statement.body)) {
          visitStatements(statement.body.statements, qualified, exported);
        }
      }
    }
  };

  visitStatements(sf.statements, undefined, true);
  return result;
}

/** Declarations sharing file and qualified name (overloads, merging) are one Symbol. */
export function symbolKey(decl: Pick<Declaration, "file" | "qualifiedName">): string {
  return `${decl.file}#${decl.qualifiedName}`;
}

export interface SymbolGroup {
  key: string;
  decls: Declaration[];
  /** The Declaration that represents the Symbol: the implementation when overloaded. */
  primary: Declaration;
}

export function groupSymbols(decls: readonly Declaration[]): SymbolGroup[] {
  const groups = new Map<string, Declaration[]>();
  for (const decl of decls) {
    const key = symbolKey(decl);
    const list = groups.get(key);
    if (list) list.push(decl);
    else groups.set(key, [decl]);
  }
  return [...groups.entries()].map(([key, list]) => ({
    key,
    decls: list,
    primary: list.find((d) => d.hasBody) ?? list[0]!,
  }));
}

// --- Targets ---

export type Target =
  | { kind: "name"; name: string; member?: string }
  | { kind: "position"; file: string; line: number; col?: number };

const IDENT = /^[A-Za-z_$#][\w$]*$/;
const POSITION = /^(.+?):(\d+)(?::(\d+))?$/;

/**
 * `save`, `User.save` or `path:line[:col]` (1-based). With `fuzzy`, a name may
 * be any substring (no identifier check).
 */
export function parseTarget(raw: string, options: { fuzzy?: boolean } = {}): Target {
  const value = raw.trim();
  const pos = POSITION.exec(value);
  if (pos) {
    const line = Number(pos[2]);
    const col = pos[3] === undefined ? undefined : Number(pos[3]);
    if (line < 1 || (col !== undefined && col < 1)) {
      throw usageError(`invalid position '${raw}' - line and column are 1-based`);
    }
    return { kind: "position", file: pos[1]!, line, ...(col !== undefined ? { col } : {}) };
  }
  const parts = value.split(".");
  const valid = options.fuzzy ? parts.every((p) => p.length > 0) : parts.every((p) => IDENT.test(p));
  if (value === "" || parts.length > 2 || !valid) {
    throw usageError(`invalid target '${raw}'`, [
      "targets: a name (save), a member (User.save) or a position (src/a.ts:42 or src/a.ts:42:7)",
    ]);
  }
  return parts.length === 2 ? { kind: "name", name: parts[0]!, member: parts[1]! } : { kind: "name", name: parts[0]! };
}

// --- Suggestions ---

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Up to 5 candidates within edit distance 2 or sharing a prefix (min 3 chars), closest first. */
export function didYouMean(name: string, candidates: Iterable<string>): string[] {
  const needle = name.toLowerCase();
  const scored: Array<{ name: string; score: number }> = [];
  for (const candidate of new Set(candidates)) {
    if (candidate === name) continue;
    const c = candidate.toLowerCase();
    const distance = editDistance(needle, c);
    const prefix = Math.min(needle.length, c.length) >= 3 && (c.startsWith(needle) || needle.startsWith(c));
    if (distance <= 2 || prefix) scored.push({ name: candidate, score: distance <= 2 ? distance : 3 + Math.abs(c.length - needle.length) / 100 });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((s) => s.name);
}
