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
  "state",
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
  /** Unclipped Signature, compared by `impact`. */
  fullSignature?: string;
  /** Registered by a string (`.controller('Name', fn)`): `namePos` is the function, not an identifier of the name. */
  nameless?: true;
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

/** Text up to the body of a function initializer, or up to the end of the type annotation (the initializer is the body). */
function headText(node: ts.Node, sf: ts.SourceFile, init: ts.Expression | undefined, typeEnd: number): string {
  if (isFunctionInitializer(init)) {
    const text = tokenText(node, sf, node.getStart(sf), init.body.getStart(sf));
    return ts.isArrowFunction(init) ? text.replace(/\s*=>$/, " =>") : text;
  }
  return tokenText(node, sf, node.getStart(sf), typeEnd);
}

/** Uncapped Signature text; `signatureOf` clips it for display. */
export function fullSignatureOf(node: ts.Node, sf: ts.SourceFile): string {
  if (ts.isVariableDeclaration(node)) {
    const list = node.parent;
    const statement = list.parent;
    const head = ts.isVariableDeclarationList(list) && ts.isVariableStatement(statement)
      ? tokenText(statement, sf, statement.getStart(sf), list.declarations[0]!.getStart(sf))
      : "";
    return `${head} ${headText(node, sf, node.initializer, (node.type ?? node.exclamationToken ?? node.name).end)}`.trim();
  }
  if (ts.isPropertyDeclaration(node)) {
    return headText(node, sf, node.initializer, (node.type ?? node.exclamationToken ?? node.questionToken ?? node.name).end).replace(/;$/, "");
  }
  if (ts.isEnumMember(node)) return tokenText(node, sf, node.getStart(sf), node.name.end);
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

/** Registration verbs whose `('Name', fn)` call introduces a nested Declaration (AngularJS style). */
const REGISTRATION_VERBS: ReadonlySet<string> = new Set(["controller", "service", "factory", "directive", "filter", "component", "run", "config", "provider"]);
/** Verbs whose callback is a constructor: its `this.x = function` statements are members. */
const CONSTRUCTOR_VERBS: ReadonlySet<string> = new Set(["controller", "service", "provider"]);
/** Router providers whose `.state(...)` / `.when(...)` calls declare a state (ui-router, ngRoute). */
const STATE_PROVIDER = /^\$?stateProvider$/i;
const ROUTE_PROVIDER = /^\$?routeProvider$/i;
/** Directive definition keys whose object literal lists the bindings. */
const BINDING_KEYS: ReadonlySet<string> = new Set(["scope", "bindToController", "bindings"]);
/** `Template.x.<hook>(fn)` lifecycle callbacks. */
const TEMPLATE_HOOKS: ReadonlySet<string> = new Set(["onCreated", "onRendered", "onDestroyed"]);

type FunctionNode = ts.FunctionExpression | ts.ArrowFunction;

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isPrefixUnaryExpression(e)) e = e.operand;
    else if (ts.isVoidExpression(e)) e = e.expression;
    else return e;
  }
}

function asFunction(expr: ts.Expression | undefined): FunctionNode | undefined {
  if (!expr) return undefined;
  const e = unwrap(expr);
  return ts.isFunctionExpression(e) || ts.isArrowFunction(e) ? e : undefined;
}

/** Statements of an IIFE body: `(function () {...})()`, `!function () {...}()`, `(function () {...}).call(this)`. */
function iifeBody(expr: ts.Expression | undefined): readonly ts.Statement[] | undefined {
  if (!expr) return undefined;
  const call = unwrap(expr);
  if (!ts.isCallExpression(call)) return undefined;
  let callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee) && (callee.name.text === "call" || callee.name.text === "apply")) callee = unwrap(callee.expression);
  const fn = asFunction(callee);
  return fn && ts.isBlock(fn.body) ? fn.body.statements : undefined;
}

/** The callback of a registration: a function, or the last element of a DI array. */
function registeredFunction(arg: ts.Expression | undefined): FunctionNode | undefined {
  if (!arg) return undefined;
  if (ts.isArrayLiteralExpression(arg)) return asFunction(arg.elements[arg.elements.length - 1]);
  return asFunction(arg);
}

function isStringName(node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

function compact(node: ts.Node, sf: ts.SourceFile): string {
  return node.getText(sf).replace(/\s+/g, "");
}

/** Parameter list (and return type) of a function as `(a, b): T`. */
function paramsText(fn: FunctionNode, sf: ts.SourceFile): string {
  const params = fn.parameters.map((p) => tokenText(p, sf, p.getStart(sf), p.end)).join(", ");
  return `(${params})${fn.type ? `: ${tokenText(fn.type, sf, fn.type.getStart(sf), fn.type.end)}` : ""}`;
}

/** `node` text up to the body of its function value; `=>` kept for arrows. */
function headUntil(node: ts.Node, fn: FunctionNode, sf: ts.SourceFile): string {
  const text = tokenText(node, sf, node.getStart(sf), fn.body.getStart(sf));
  return ts.isArrowFunction(fn) ? text.replace(/\s*=>$/, " =>") : text;
}

interface Raw {
  start: number;
  end: number;
  kind: Kind;
  name: string;
  qualifiedName: string;
  parentName?: string;
  exported: boolean;
  signature: string;
  namePos: number;
  hasBody: boolean;
  nameless?: true;
}

/**
 * Declarations of a file in source order: top-level ones with class, interface
 * and enum members and namespace members following their parent, plus nested
 * declarations of script-style code (registrations, IIFE helpers, prototype and
 * object-literal methods; see GLOSSARY.md Declaration).
 */
export function collectDeclarations(sf: ts.SourceFile, file: string): Declaration[] {
  const raws: Raw[] = [];
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
    const body = bodyOf(ts.isVariableDeclaration(node) && isFunctionInitializer(node.initializer) ? node.initializer : node);
    raws.push({
      start,
      end: node.end,
      kind,
      name,
      qualifiedName: parent ? `${parent}.${name}` : name,
      exported,
      signature: fullSignatureOf(node, sf),
      ...(parent ? { parentName: parent } : {}),
      namePos: nameNode ? nameNode.getStart(sf) : start,
      hasBody:
        body !== undefined ||
        !(ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)),
    });
  };

  const nested = (raw: Omit<Raw, "qualifiedName" | "hasBody"> & { qualifiedName?: string }): void => {
    raws.push({ ...raw, qualifiedName: raw.qualifiedName ?? (raw.parentName ? `${raw.parentName}.${raw.name}` : raw.name), hasBody: true });
  };

  /** Method and function-valued properties of an object literal as `<holder>.<name>`. */
  const objectMembers = (obj: ts.ObjectLiteralExpression, holder: string, exported: boolean): void => {
    for (const prop of obj.properties) {
      const name = nameText(prop.name, sf);
      if (!name || !prop.name) continue;
      if (ts.isMethodDeclaration(prop)) {
        nested({ start: prop.getStart(sf), end: prop.end, kind: "method", name, parentName: holder, exported, signature: fullSignatureOf(prop, sf), namePos: prop.name.getStart(sf) });
      } else if (ts.isPropertyAssignment(prop)) {
        const fn = asFunction(prop.initializer);
        if (fn) nested({ start: prop.getStart(sf), end: prop.end, kind: "method", name, parentName: holder, exported, signature: headUntil(prop, fn, sf), namePos: prop.name.getStart(sf) });
      }
    }
  };

  /** `this.x = function` statements at the top level of a constructor-like body. */
  const thisMembers = (body: ts.ConciseBody | undefined, owner: string, exported: boolean): void => {
    if (!body || !ts.isBlock(body)) return;
    for (const statement of body.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
      const { left, operatorToken, right } = statement.expression;
      const fn = asFunction(right);
      if (operatorToken.kind !== ts.SyntaxKind.EqualsToken || !fn || !ts.isPropertyAccessExpression(left) || left.expression.kind !== ts.SyntaxKind.ThisKeyword) continue;
      nested({ start: statement.getStart(sf), end: statement.end, kind: "method", name: left.name.text, parentName: owner, exported, signature: headUntil(statement.expression, fn, sf), namePos: left.name.getStart(sf) });
    }
  };

  /** Top-level object literals returned by a factory: its API. */
  const returnedMembers = (body: ts.ConciseBody, owner: string): void => {
    if (ts.isObjectLiteralExpression(unwrap(body as ts.Expression))) return objectMembers(unwrap(body as ts.Expression) as ts.ObjectLiteralExpression, owner, true);
    if (!ts.isBlock(body)) return;
    for (const statement of body.statements) {
      if (ts.isReturnStatement(statement) && statement.expression && ts.isObjectLiteralExpression(unwrap(statement.expression))) {
        objectMembers(unwrap(statement.expression) as ts.ObjectLiteralExpression, owner, true);
      }
    }
  };

  const topLevelExported = (name: string): boolean => raws.find((r) => r.qualifiedName === name && r.parentName === undefined)?.exported ?? false;
  const isConstructorName = (name: string): boolean => /^[A-Z]/.test(name);

  /** `.controller('Name', fn)` and friends; `.run(fn)` / `.config(fn)` take the verb as name. */
  const registration = (call: ts.CallExpression, verb: string): void => {
    const [first, second] = call.arguments;
    const named = isStringName(first);
    if (!named && verb !== "run" && verb !== "config") return;
    const name = named ? first.text : verb;
    const arg = named ? second : first;
    const callee = call.expression as ts.PropertyAccessExpression;
    const start = named ? first.getStart(sf) : callee.name.getStart(sf);
    if (verb === "component" && arg && ts.isObjectLiteralExpression(arg)) {
      nested({ start, end: arg.end, kind: "variable", name, exported: true, signature: `component ${name}`, namePos: arg.getStart(sf), nameless: true });
      objectMembers(arg, name, true);
      bindingMembers(arg, name);
      return;
    }
    const fn = registeredFunction(arg);
    if (!fn) return;
    const inject = arg && ts.isArrayLiteralExpression(arg) ? ` [${arg.elements.slice(0, -1).map((e) => e.getText(sf)).join(", ")}]` : "";
    nested({
      start,
      end: arg!.end,
      kind: "function",
      name,
      qualifiedName: name,
      parentName: verb,
      exported: true,
      signature: `${verb} ${name}${paramsText(fn, sf)}`,
      namePos: (ts.isFunctionExpression(fn) && fn.name ? fn.name : fn).getStart(sf),
      nameless: true,
    });
    // The DI array is compared, not displayed: reordering injections is a contract change.
    if (inject) raws[raws.length - 1]!.signature += `\n${inject.trim()}`;
    if (CONSTRUCTOR_VERBS.has(verb)) thisMembers(fn.body, name, true);
    if (verb === "factory" || verb === "service") returnedMembers(fn.body, name);
    if (verb === "directive") for (const obj of returnedObjects(fn.body)) bindingMembers(obj, name);
    if (verb === "config" || verb === "run") routerBody(fn.body);
  };

  /** Object literals a function returns at its top level (a directive definition object). */
  const returnedObjects = (body: ts.ConciseBody): ts.ObjectLiteralExpression[] => {
    const direct = unwrap(body as ts.Expression);
    if (ts.isObjectLiteralExpression(direct)) return [direct];
    if (!ts.isBlock(body)) return [];
    return body.statements.flatMap((st) => (ts.isReturnStatement(st) && st.expression && ts.isObjectLiteralExpression(unwrap(st.expression)) ? [unwrap(st.expression) as ts.ObjectLiteralExpression] : []));
  };

  /** `scope: { x: '=' }` / `bindToController` / `bindings` keys as `property` Declarations `<owner>.x`. */
  const bindingMembers = (obj: ts.ObjectLiteralExpression, owner: string): void => {
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) || !BINDING_KEYS.has(nameText(prop.name, sf) ?? "")) continue;
      const bindings = unwrap(prop.initializer);
      if (!ts.isObjectLiteralExpression(bindings)) continue;
      for (const b of bindings.properties) {
        const name = nameText(b.name, sf);
        if (!name || !b.name || !ts.isPropertyAssignment(b)) continue;
        nested({ start: b.getStart(sf), end: b.end, kind: "property", name, parentName: owner, exported: true, signature: tokenText(b, sf, b.getStart(sf), b.end), namePos: b.name.getStart(sf) });
      }
    }
  };

  /** Function-valued properties of a state object (`resolve.x`, `onEnter`, `views.main.controller`) as methods; nested objects recurse. */
  const stateMembers = (obj: ts.ObjectLiteralExpression, holder: string, depth: number): void => {
    for (const prop of obj.properties) {
      const name = nameText(prop.name, sf);
      if (!name || !prop.name) continue;
      if (ts.isMethodDeclaration(prop)) {
        nested({ start: prop.getStart(sf), end: prop.end, kind: "method", name, parentName: holder, exported: true, signature: fullSignatureOf(prop, sf), namePos: prop.name.getStart(sf) });
      } else if (ts.isPropertyAssignment(prop)) {
        const value = unwrap(prop.initializer);
        const fn = registeredFunction(value);
        if (fn) nested({ start: prop.getStart(sf), end: prop.end, kind: "method", name, parentName: holder, exported: true, signature: `${name}${paramsText(fn, sf)}`, namePos: prop.name.getStart(sf) });
        else if (ts.isObjectLiteralExpression(value) && depth < 3) stateMembers(value, `${holder}.${name}`, depth + 1);
      }
    }
  };

  /** One `.state('name', {...})`, `.state({ name, ... })` or `.when('/path', {...})` call. */
  const stateCall = (call: ts.CallExpression, route: boolean): void => {
    const [first, second] = call.arguments;
    const obj = first && ts.isObjectLiteralExpression(first) && !route ? first : second && ts.isObjectLiteralExpression(second) ? second : undefined;
    if (!obj) return;
    const literal = (key: string): string | undefined => {
      const prop = obj.properties.find((p) => ts.isPropertyAssignment(p) && nameText(p.name, sf) === key) as ts.PropertyAssignment | undefined;
      return prop && isStringName(prop.initializer) ? prop.initializer.text : undefined;
    };
    const name = isStringName(first) ? first.text : literal("name");
    if (name === undefined) return;
    const url = literal("url");
    const parent = route ? "routes" : "states";
    // Plain-literal options are compared, not displayed: a new controller or template is a contract change.
    const options = obj.properties
      .filter((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && nameText(p.name, sf) !== "name" && nameText(p.name, sf) !== "url")
      .filter((p) => isStringName(p.initializer) || p.initializer.kind === ts.SyntaxKind.TrueKeyword || p.initializer.kind === ts.SyntaxKind.FalseKeyword)
      .map((p) => tokenText(p, sf, p.getStart(sf), p.end));
    const callee = call.expression as ts.PropertyAccessExpression;
    nested({
      start: callee.name.getStart(sf),
      end: call.end,
      kind: "state",
      name,
      parentName: parent,
      exported: true,
      signature: `${route ? "route" : "state"} ${name}${url !== undefined && !route ? ` (url ${url})` : ""}${options.length > 0 ? `\n${options.join("; ")}` : ""}`,
      namePos: obj.getStart(sf),
      nameless: true,
    });
    stateMembers(obj, `${parent}.${name}`, 1);
  };

  /** `$stateProvider.state(...).state(...)` and `$routeProvider.when(...)` chains; `.otherwise()` ignored. */
  const routerChain = (expr: ts.Expression): boolean => {
    const calls: ts.CallExpression[] = [];
    let e = unwrap(expr);
    while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      calls.push(e);
      e = e.expression.expression;
    }
    if (!ts.isIdentifier(e)) return false;
    const route = ROUTE_PROVIDER.test(e.text);
    if (!route && !STATE_PROVIDER.test(e.text)) return false;
    for (const call of calls.reverse()) {
      const verb = (call.expression as ts.PropertyAccessExpression).name.text;
      if (verb === (route ? "when" : "state")) stateCall(call, route);
    }
    return true;
  };

  /** Router chains at the top level of a `.config` / `.run` callback or of a function taking a router provider. */
  const routerBody = (body: ts.ConciseBody | undefined): void => {
    if (!body || !ts.isBlock(body)) return;
    for (const statement of body.statements) if (ts.isExpressionStatement(statement)) routerChain(statement.expression);
  };
  const takesRouter = (fn: ts.SignatureDeclarationBase): boolean =>
    fn.parameters.some((p) => ts.isIdentifier(p.name) && (STATE_PROVIDER.test(p.name.text) || ROUTE_PROVIDER.test(p.name.text)));

  /** Registrations along a call chain (`angular.module('x').controller(...).service(...)`), in source order. */
  const callChain = (expr: ts.Expression): void => {
    if (routerChain(expr)) return;
    const calls: Array<{ call: ts.CallExpression; name: string }> = [];
    let e = unwrap(expr);
    while (ts.isCallExpression(e)) {
      const callee = e.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        calls.push({ call: e, name: callee.name.text });
        e = callee.expression;
      } else {
        break;
      }
    }
    for (const { call, name } of calls.reverse()) {
      const callee = call.expression as ts.PropertyAccessExpression;
      const receiver = compact(callee.expression, sf);
      const first = call.arguments[0];
      if (receiver === "Meteor" && name === "methods" && first && ts.isObjectLiteralExpression(first)) {
        objectMembers(first, "methods", true);
      } else if (receiver.startsWith("Template") && (name === "helpers" || name === "events") && first && ts.isObjectLiteralExpression(first)) {
        objectMembers(first, `${receiver}.${name}`, true);
      } else if (receiver.startsWith("Template") && TEMPLATE_HOOKS.has(name) && asFunction(first)) {
        nested({ start: call.getStart(sf), end: call.end, kind: "method", name, parentName: receiver, exported: true, signature: `${receiver}.${headUntil(first!, asFunction(first)!, sf)}`, namePos: callee.name.getStart(sf) });
      } else if (REGISTRATION_VERBS.has(name)) {
        registration(call, name);
      }
    }
  };

  /** `exports.x = fn`, `module.exports = {...}`, `Foo.prototype.bar = fn`, `Foo.bar = fn`. */
  const assignment = (statement: ts.ExpressionStatement, expr: ts.BinaryExpression): void => {
    const left = expr.left;
    const right = unwrap(expr.right);
    if (!ts.isPropertyAccessExpression(left)) return;
    const target = compact(left, sf);
    if (target === "module.exports") {
      if (ts.isObjectLiteralExpression(right)) objectMembers(right, "exports", true);
      return;
    }
    const owner = left.expression;
    if (ts.isPropertyAccessExpression(owner) && owner.name.text === "prototype" && ts.isIdentifier(owner.expression)) {
      const cls = owner.expression.text;
      const fn = asFunction(right);
      if (fn) nested({ start: statement.getStart(sf), end: statement.end, kind: "method", name: left.name.text, parentName: cls, exported: topLevelExported(cls), signature: headUntil(expr, fn, sf), namePos: left.name.getStart(sf) });
      return;
    }
    if (ts.isIdentifier(left.name) && left.name.text === "prototype" && ts.isIdentifier(owner) && ts.isObjectLiteralExpression(right)) {
      objectMembers(right, owner.text, topLevelExported(owner.text));
      return;
    }
    const fn = asFunction(right);
    if (!fn) return;
    const holder = target === `module.exports.${left.name.text}` ? "exports" : ts.isIdentifier(owner) ? owner.text : undefined;
    if (holder === undefined) return;
    const exported = holder === "exports" || topLevelExported(holder);
    nested({ start: statement.getStart(sf), end: statement.end, kind: "method", name: left.name.text, parentName: holder, exported, signature: headUntil(expr, fn, sf), namePos: left.name.getStart(sf) });
  };

  /** Script-style patterns of one module-level statement; `inIife` adds the IIFE's own functions. */
  const scriptStatement = (statement: ts.Statement, inIife: boolean): void => {
    if (ts.isFunctionDeclaration(statement)) {
      if (!statement.name || !statement.body) return;
      if (inIife) add(statement, statement.name, statement.name.text, false);
      if (isConstructorName(statement.name.text)) thisMembers(statement.body, statement.name.text, inIife ? false : topLevelExported(statement.name.text));
      if (takesRouter(statement)) routerBody(statement.body);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const name = decl.name.text;
        const fn = asFunction(decl.initializer);
        if (inIife && fn) add(decl, decl.name, name, false);
        if (fn && takesRouter(fn)) routerBody(fn.body);
        const exported = inIife ? false : topLevelExported(name);
        const init = unwrap(decl.initializer);
        if (ts.isObjectLiteralExpression(init)) objectMembers(init, name, exported);
        else if (fn && isConstructorName(name)) thisMembers(fn.body, name, exported);
        else {
          const body = iifeBody(decl.initializer);
          if (body) scriptStatements(body, true);
          else callChain(decl.initializer);
        }
      }
    } else if (ts.isExpressionStatement(statement)) {
      const expr = unwrap(statement.expression);
      const body = iifeBody(expr);
      if (body) scriptStatements(body, true);
      else if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) assignment(statement, expr);
      else callChain(expr);
    } else if (ts.isIfStatement(statement)) {
      scriptStatement(statement.thenStatement, inIife);
      if (statement.elseStatement) scriptStatement(statement.elseStatement, inIife);
    } else if (ts.isBlock(statement)) {
      scriptStatements(statement.statements, inIife);
    }
  };
  const scriptStatements = (statements: readonly ts.Statement[], inIife: boolean): void => {
    for (const statement of statements) scriptStatement(statement, inIife);
  };

  const visitStatements = (statements: readonly ts.Statement[], parent: string | undefined, parentExported: boolean): void => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const exported = parent ? parentExported && hasModifier(statement, ts.SyntaxKind.ExportKeyword) : isTopLevelExported(statement, decl.name.text, local);
          add(decl, decl.name, decl.name.text, exported, parent);
        }
        if (!parent) scriptStatement(statement, false);
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
        } else if (ts.isFunctionDeclaration(statement) && !parent) {
          scriptStatement(statement, false);
        }
        continue;
      }
      if (!parent) scriptStatement(statement, false);
    }
  };

  visitStatements(sf.statements, undefined, true);
  // Nested declarations are found after their holder statement; source order is start order.
  const ordered = raws.map((r, i) => ({ r, i })).sort((a, b) => a.r.start - b.r.start || a.i - b.i);
  return ordered.map(({ r }) => {
    const startLc = sf.getLineAndCharacterOfPosition(r.start);
    const full = r.signature;
    return {
      file,
      line: startLc.line + 1,
      col: startLc.character + 1,
      endLine: sf.getLineAndCharacterOfPosition(r.end).line + 1,
      kind: r.kind,
      name: r.name,
      qualifiedName: r.qualifiedName,
      exported: r.exported,
      signature: clip(full.split("\n")[0]!),
      ...(r.parentName !== undefined ? { parentName: r.parentName } : {}),
      namePos: r.namePos,
      nameLine: sf.getLineAndCharacterOfPosition(r.namePos).line + 1,
      hasBody: r.hasBody,
      fullSignature: full,
      ...(r.nameless ? { nameless: true as const } : {}),
    };
  });
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
