// Project discovery and the two engine paths (ADR 0001): a syntactic index
// over `ts.createSourceFile`, and a LanguageService for semantic queries.
import { diskFs, sourceFs, type SourceFs } from "./fs.js";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { usageError } from "./errors.js";
import { classifyReferenceGroups, type GroupDescriptor, type RefDescriptor, type Through } from "./references.js";
import { collectDeclarations, type Declaration } from "./symbols.js";
import { byDepthThenPath, listFiles } from "./walk.js";
import { detectWorkspace, hasMultiProjectSignal, isMultiProject, type Workspace, type WorkspaceKind } from "./workspace.js";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] as const;
/** An implicit project above this many files is analysed by importer subgraph, not as a whole. */
export const IMPLICIT_SCOPE_THRESHOLD = 3_000;

export const IMPLICIT_WARNING = "no tsconfig.json found - implicit project";

function real(path: string): string {
  try {
    return sourceFs().realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * TypeScript's system calls over the active SourceFs: `ts.sys` itself on disk (unchanged
 * behaviour), else the same calls answered by the git tree, with `ts.matchFiles` for globs.
 */
export type FsSystem = ts.ParseConfigHost & ts.ModuleResolutionHost & {
  directoryExists(path: string): boolean;
  getDirectories(path: string): string[];
  realpath?(path: string): string;
  readDirectory(path: string, extensions?: readonly string[], exclude?: readonly string[], include?: readonly string[], depth?: number): string[];
};

type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => { files: readonly string[]; directories: readonly string[] },
  realpath: (path: string) => string,
) => string[];

const systems = new WeakMap<SourceFs, FsSystem>();

export function tsSystem(fs: SourceFs = sourceFs()): FsSystem {
  if (fs === diskFs) return ts.sys;
  let system = systems.get(fs);
  if (system) return system;
  // Internal but stable since TS 2.x; ts.sys.readDirectory uses the same function.
  const matchFiles = (ts as unknown as { matchFiles: MatchFiles }).matchFiles;
  const realpath = (p: string): string => {
    try {
      return fs.realpath(p);
    } catch {
      return p;
    }
  };
  const entries = (dir: string): { files: string[]; directories: string[] } => {
    const list = fs.readdir(dir);
    return { files: list.filter((e) => e.isFile).map((e) => e.name), directories: list.filter((e) => e.isDirectory).map((e) => e.name) };
  };
  system = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (p) => fs.isFile(p),
    // ts.sys.readFile drops a UTF-8 BOM.
    readFile: (p) => fs.readFile(p)?.replace(/^﻿/, ""),
    directoryExists: (p) => fs.isDirectory(p),
    getDirectories: (p) => entries(p).directories,
    realpath,
    readDirectory: (path, extensions, exclude, include, depth) =>
      matchFiles(path, extensions, exclude, include, ts.sys.useCaseSensitiveFileNames, process.cwd(), depth, entries, realpath),
  };
  systems.set(fs, system);
  return system;
}

/** Nearest ancestor of `cwd` (inclusive) holding `.git`, else `cwd`; the tree root under `--ref`. */
export function findRepoRoot(cwd: string): string {
  const ref = sourceFs().ref;
  if (ref) return ref.root;
  const start = real(cwd);
  let dir = start;
  for (;;) {
    if (sourceFs().exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export interface TsconfigLocation {
  /** Absolute path, or null for an implicit project. */
  path: string | null;
  implicit: boolean;
}

export interface DiscoverOptions {
  /** `-P` value, absolute or relative to `cwd`. */
  override?: string;
  cwd?: string;
  /** `.ts-axi.json` `project`, relative to `settingsRoot`. */
  settingsProject?: string;
  settingsRoot?: string;
  /** Do not walk above this directory (the repo root). */
  stopAt?: string;
}

function explicitTsconfig(raw: string, base: string, source: string): string {
  const abs = resolve(base, raw);
  const file = sourceFs().isDirectory(abs) ? join(abs, "tsconfig.json") : abs;
  if (!sourceFs().exists(file)) {
    throw usageError(`tsconfig not found: ${raw} (${source})`, [
      "pass an existing tsconfig with -P <path>, or omit it to use the nearest tsconfig.json",
    ]);
  }
  return real(file);
}

/** `-P` override → `.ts-axi.json` `project` → nearest `tsconfig.json` walking up → implicit. */
export function discoverTsconfig(startDir: string, options: DiscoverOptions = {}): TsconfigLocation {
  if (options.override) {
    return { path: explicitTsconfig(options.override, options.cwd ?? startDir, "-P"), implicit: false };
  }
  if (options.settingsProject) {
    return {
      path: explicitTsconfig(options.settingsProject, options.settingsRoot ?? startDir, ".ts-axi.json project"),
      implicit: false,
    };
  }
  let dir = real(startDir);
  for (;;) {
    const candidate = join(dir, "tsconfig.json");
    if (sourceFs().exists(candidate)) return { path: candidate, implicit: false };
    const parent = dirname(dir);
    if (parent === dir || (options.stopAt !== undefined && dir === real(options.stopAt))) return { path: null, implicit: true };
    dir = parent;
  }
}

export function isSourceFile(name: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !/\.d\.[mc]?ts$/.test(name);
}

/** Every source file below `root` from the shared listing (`src/walk.ts`: git, else fs walk), minus `.d.ts`. */
export function walkSourceFiles(root: string): string[] {
  return listFiles(root, isSourceFile).files;
}

// `Bundler` resolves `require('..')` (directory `main`/`index.js`), ESM `./x.js` specifiers and
// `"type": "module"` packages alike; NodeNext/Node10 gave the same References on CommonJS and ESM
// samples. What breaks plain JavaScript is not the option set but `.d.ts` twins and
// `module.exports = require()` shims, handled by `resolveModuleNameLiterals` in the host.
export const IMPLICIT_COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  strict: false,
  skipLibCheck: true,
  noEmit: true,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  resolveJsonModule: true,
};

/** Set when semantic commands build their program from an importer subgraph instead of the whole Project. */
export interface ProjectScope {
  workspace: Workspace;
  kind: WorkspaceKind;
}

export interface ParsedProject {
  root: string;
  tsconfig: string | null;
  implicit: boolean;
  /** Absolute source file paths (node_modules excluded). */
  fileNames: string[];
  options: ts.CompilerOptions;
  /** A references-only tsconfig expanded to this many referenced configs. */
  referenced?: number;
  scope?: ProjectScope;
}

export interface ExpandedConfig {
  path: string;
  fileNames: string[];
  options: ts.CompilerOptions;
}

function readTsconfig(path: string): ts.ParsedCommandLine | undefined {
  const read = ts.readConfigFile(path, tsSystem().readFile);
  if (read.error) return undefined;
  return ts.parseJsonConfigFileContent(read.config, tsSystem(), dirname(path), undefined, path);
}

function sourceNames(parsed: ts.ParsedCommandLine): string[] {
  return parsed.fileNames
    .map((f) => resolve(f))
    .filter((f) => !f.split(sep).includes("node_modules") && SOURCE_EXTENSIONS.some((ext) => f.endsWith(ext)));
}

/**
 * The configs a tsconfig stands for: itself, or - when it has `references` and no files of its
 * own (an Nx project shell) - its referenced configs, recursively and deduplicated.
 */
export function expandTsconfig(path: string): ExpandedConfig[] {
  const result: ExpandedConfig[] = [];
  const seen = new Set<string>();
  const visit = (file: string): void => {
    const abs = real(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    const parsed = readTsconfig(abs);
    if (!parsed) return;
    const fileNames = sourceNames(parsed);
    const refs = parsed.projectReferences ?? [];
    if (fileNames.length === 0 && refs.length > 0) {
      for (const ref of refs) {
        const target = ts.resolveProjectReferencePath(ref);
        if (sourceFs().exists(target)) visit(target);
      }
      return;
    }
    result.push({ path: abs, fileNames, options: parsed.options });
  };
  visit(path);
  return result;
}

/** One config's options for a union: the first config's, with every config's `types` merged. */
function unionOptions(configs: readonly ExpandedConfig[]): ts.CompilerOptions {
  const types = configs.some((c) => c.options.types === undefined) ? undefined : [...new Set(configs.flatMap((c) => c.options.types ?? []))];
  return { ...configs[0]!.options, ...(types ? { types } : {}) };
}

/** Resolve the Project's file list and compiler options. Cheap: reads directories, parses no source. */
export function loadProject(root: string, location: TsconfigLocation): ParsedProject {
  if (!location.path) {
    return { root, tsconfig: null, implicit: true, fileNames: walkSourceFiles(root), options: IMPLICIT_COMPILER_OPTIONS };
  }
  const read = ts.readConfigFile(location.path, tsSystem().readFile);
  if (read.error) {
    throw usageError(`cannot read ${location.path} - ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
  }
  const configs = expandTsconfig(location.path);
  const self = configs.length === 1 && configs[0]!.path === real(location.path);
  if (self || configs.length === 0) {
    const parsed = ts.parseJsonConfigFileContent(read.config, tsSystem(), dirname(location.path), undefined, location.path);
    return { root, tsconfig: location.path, implicit: false, fileNames: sourceNames(parsed), options: { ...parsed.options, noEmit: true } };
  }
  const fileNames = [...new Set(configs.flatMap((c) => c.fileNames))].sort();
  return { root, tsconfig: location.path, implicit: false, fileNames, options: { ...unionOptions(configs), noEmit: true }, referenced: configs.length };
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parseSource(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
}

export interface NameQuery {
  name: string;
  member?: string;
  /** Substring, case-insensitive. */
  fuzzy?: boolean;
}

export interface SyntacticIndex {
  project: ParsedProject;
  root: string;
  files: string[];
  /** Absolute → repo-root-relative with `/`. */
  rel(abs: string): string;
  /** Repo-root-relative → absolute. */
  abs(rel: string): string;
  text(abs: string): string | undefined;
  sourceFile(abs: string): ts.SourceFile | undefined;
  declarations(abs: string): Declaration[];
  /** Declarations matching a name; only files whose text contains the name are parsed. */
  findDeclarations(query: NameQuery): Declaration[];
  /** Every Declaration name and qualified name in the Project (parses every file). */
  allNames(): Set<string>;
}

export function relPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

export function declMatches(decl: Declaration, query: NameQuery): boolean {
  const needle = query.fuzzy ? query.name.toLowerCase() : query.name;
  if (query.member !== undefined) {
    if (decl.parentName === undefined) return false;
    const parent = decl.parentName.split(".").pop()!;
    return query.fuzzy
      ? parent.toLowerCase().includes(needle) && decl.name.toLowerCase().includes(query.member.toLowerCase())
      : parent === query.name && decl.name === query.member;
  }
  return query.fuzzy ? decl.name.toLowerCase().includes(needle) : decl.name === query.name;
}

// Same bounds as the home view's walk: this runs on an empty result, it must stay cheap.
const OUTSIDE_WALK_CAP = 20_000;
const OUTSIDE_WALK_MS = 600;

/**
 * Declarations matching `query` in source files below the repo root that are not in the Project
 * (syntactic; the fs fallback is bounded by file count and time; at most `max` hits, shallowest paths first).
 */
export function findOutsideProject(index: SyntacticIndex, query: NameQuery, max = 3): Declaration[] {
  const inProject = new Set(index.files);
  const { files } = listFiles(index.root, isSourceFile, { maxFiles: OUTSIDE_WALK_CAP, deadline: Date.now() + OUTSIDE_WALK_MS });
  const hits: Declaration[] = [];
  sourceFs().prefetch(files.filter((f) => !inProject.has(f)));
  for (const path of files.sort((a, b) => byDepthThenPath(index.rel(a), index.rel(b)))) {
    if (inProject.has(path)) continue;
    const text = index.text(path);
    if (text === undefined || !text.includes(query.name)) continue;
    for (const decl of index.declarations(path)) if (declMatches(decl, query)) hits.push(decl);
    if (hits.length >= max) break;
  }
  return hits.slice(0, max).sort((a, b) => byDepthThenPath(a.file, b.file) || a.line - b.line);
}

/** Nearest `tsconfig.json` from the directory of `abs` up to `root` (inclusive). */
export function nearestTsconfig(abs: string, root: string): string | undefined {
  for (let dir = dirname(abs); ; dir = dirname(dir)) {
    const candidate = join(dir, "tsconfig.json");
    if (sourceFs().exists(candidate)) return candidate;
    if (dir === root || dirname(dir) === dir) return undefined;
  }
}

export function createSyntacticIndex(root: string, project: ParsedProject): SyntacticIndex {
  const texts = new Map<string, string | undefined>();
  const sources = new Map<string, ts.SourceFile | undefined>();
  const decls = new Map<string, Declaration[]>();

  const index: SyntacticIndex = {
    project,
    root,
    files: project.fileNames,
    rel: (abs) => relPath(root, abs),
    abs: (rel) => (isAbsolute(rel) ? rel : join(root, rel)),
    text(abs) {
      if (!texts.has(abs)) texts.set(abs, sourceFs().readFile(abs));
      return texts.get(abs);
    },
    sourceFile(abs) {
      if (!sources.has(abs)) {
        const text = index.text(abs);
        sources.set(abs, text === undefined ? undefined : parseSource(abs, text));
      }
      return sources.get(abs);
    },
    declarations(abs) {
      let list = decls.get(abs);
      if (!list) {
        const sf = index.sourceFile(abs);
        list = sf ? collectDeclarations(sf, index.rel(abs)) : [];
        decls.set(abs, list);
      }
      return list;
    },
    findDeclarations(query) {
      // A nested holder (`states.cart`) may never be spelled in the file: prefilter on the member.
      const word = query.member ?? query.name;
      const needle = query.fuzzy ? word.toLowerCase() : word;
      const result: Declaration[] = [];
      sourceFs().prefetch(index.files);
      for (const file of index.files) {
        const text = index.text(file);
        if (text === undefined) continue;
        if (query.fuzzy ? !text.toLowerCase().includes(needle) : !text.includes(needle)) continue;
        for (const decl of index.declarations(file)) if (declMatches(decl, query)) result.push(decl);
      }
      return result;
    },
    allNames() {
      const names = new Set<string>();
      sourceFs().prefetch(index.files);
      for (const file of index.files) {
        for (const decl of index.declarations(file)) {
          names.add(decl.name);
          names.add(decl.qualifiedName);
        }
      }
      return names;
    },
  };
  return index;
}

// --- Semantic path ---

export interface Location {
  /** Repo-root-relative. */
  file: string;
  /** 1-based. */
  line: number;
  col: number;
}

export interface ReferenceEntry extends Location {
  isDefinition: boolean;
  isWrite: boolean;
}

export interface ViaEntry extends ReferenceEntry {
  /** The member the Reference names: a base (`FieldParser.parse`) or an implementation of the queried one. */
  via: string;
  through: Through;
}

export interface ReferenceSplit {
  /** References of the Symbol itself, Declarations excluded. */
  direct: ReferenceEntry[];
  declarations: ReferenceEntry[];
  /** References that reach it only through a member it implements/overrides, or that name an implementation of it. */
  via: ViaEntry[];
  /** Declarations of members that implement or override it. */
  implementations: Array<ReferenceEntry & { name: string }>;
  /** Positions the LanguageService reported that are not References of it (sibling implementations). */
  dropped: ReferenceEntry[];
  /** `Class.member` names it implements or overrides. */
  bases: string[];
}

export interface DefinitionInfo extends Location {
  name: string;
  kind: string;
  containerName: string;
  /** Absolute path and offset of the definition name, for follow-up queries. */
  absFile: string;
  pos: number;
}

export interface CallSite extends Location {
  /** Enclosing function/method of the call (`Class.method`), `(top-level)` for module code. */
  caller: string;
  item: ts.CallHierarchyItem;
  /** Set when the call reaches the Symbol through a base member or names an implementation of it. */
  via?: string;
  through?: Through;
}

export interface SemanticProject {
  index: SyntacticIndex;
  service: ts.LanguageService;
  program: ts.Program;
  /** Program files that belong to the Project (no lib, no node_modules). */
  projectFiles: string[];
  /** Direct References plus Declarations (`isDefinition`) of the Symbol at `pos`. */
  findReferences(absFile: string, pos: number): ReferenceEntry[];
  /** `findReferences` split into direct / via / implementations / dropped (see `src/references.ts`). */
  referenceSplit(absFile: string, pos: number): ReferenceSplit;
  definitionAt(absFile: string, pos: number): DefinitionInfo | undefined;
  /** Incoming calls of the function-like Symbol at `pos`, split like `referenceSplit` (dropped ones removed); undefined when it is not callable. */
  incomingCalls(absFile: string, pos: number): CallSite[] | undefined;
  /** Incoming calls of a call hierarchy item (for depth > 1). */
  incomingCallsOf(item: ts.CallHierarchyItem): CallSite[];
  quickInfo(absFile: string, pos: number): ts.QuickInfo | undefined;
  /** Syntactic + semantic diagnostics; all Project files up to 300, else only `touched`. */
  diagnosticsCount(touched?: readonly string[]): number;
  /** Milliseconds since the project was created. */
  elapsedMs(): number;
}

const FULL_DIAGNOSTICS_LIMIT = 300;

/** A program over chosen root files (an importer subgraph) instead of the whole Project. */
export interface ProgramScope {
  rootNames: string[];
  options: ts.CompilerOptions;
  currentDirectory: string;
}

const DECLARATION_TWINS: ReadonlyArray<[RegExp, ReadonlyArray<[string, ts.Extension]>]> = [
  [/\.d\.ts$/, [[".js", ts.Extension.Js], [".jsx", ts.Extension.Jsx], [".mjs", ts.Extension.Mjs], [".cjs", ts.Extension.Cjs]]],
  [/\.d\.mts$/, [[".mjs", ts.Extension.Mjs]]],
  [/\.d\.cts$/, [[".cjs", ts.Extension.Cjs]]],
];

/** The implementation beside a `.d.ts` (`index.d.ts` → `index.js`) when it is a Project source file. */
function implementationTwin(file: string, isSource: (abs: string) => boolean): { file: string; extension: ts.Extension } | undefined {
  for (const [re, impls] of DECLARATION_TWINS) {
    if (!re.test(file)) continue;
    const base = file.replace(re, "");
    for (const [ext, extension] of impls) if (isSource(base + ext)) return { file: base + ext, extension };
  }
  return undefined;
}

/** `'x'` of a module whose only statement is `module.exports = require('x')` (`exports = module.exports = ...` too). */
export function passThroughRequire(sf: ts.SourceFile): string | undefined {
  const statements = sf.statements.filter((s) => !(ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)));
  const only = statements.length === 1 ? statements[0]! : undefined;
  if (!only || !ts.isExpressionStatement(only)) return undefined;
  let expr: ts.Expression = only.expression;
  let assignsModuleExports = false;
  while (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const left = expr.left;
    if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "module" && left.name.text === "exports") {
      assignsModuleExports = true;
    } else if (!(ts.isIdentifier(left) && left.text === "exports")) return undefined;
    expr = expr.right;
  }
  if (!assignsModuleExports || !ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression) || expr.expression.text !== "require") return undefined;
  const [arg] = expr.arguments;
  return expr.arguments.length === 1 && arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

const MAX_SHIM_HOPS = 3;

/**
 * TypeScript's resolution, then two substitutions so References reach implementations:
 * a `.d.ts` with a JS twin in the Project resolves to the twin (TS tries `.d.ts` before `.js`),
 * and a `module.exports = require('x')` shim resolves to `x` (the binder makes no alias of it).
 */
function createModuleResolver(
  options: ts.CompilerOptions,
  currentDirectory: string,
  isSource: (abs: string) => boolean,
  sourceOf: (abs: string) => ts.SourceFile | undefined,
): NonNullable<ts.LanguageServiceHost["resolveModuleNameLiterals"]> {
  const system = tsSystem();
  const cache = ts.createModuleResolutionCache(currentDirectory, (s) => (ts.sys.useCaseSensitiveFileNames ? s : s.toLowerCase()), options);
  const resolveOne = (
    name: string,
    containingFile: string,
    mode: ts.ResolutionMode,
    redirected: ts.ResolvedProjectReference | undefined,
    hops: number,
  ): ts.ResolvedModuleWithFailedLookupLocations => {
    const result = ts.resolveModuleName(name, containingFile, options, system, cache, redirected, mode);
    const found = result.resolvedModule;
    if (!found) return result;
    let resolvedFileName = resolve(found.resolvedFileName);
    let extension = found.extension as ts.Extension;
    const twin = implementationTwin(resolvedFileName, isSource);
    if (twin) ({ file: resolvedFileName, extension } = twin);
    else if (!isSource(resolvedFileName)) return result;
    if (hops < MAX_SHIM_HOPS && /\.[mc]?jsx?$/.test(resolvedFileName)) {
      const sf = sourceOf(resolvedFileName);
      const inner = sf ? passThroughRequire(sf) : undefined;
      if (inner !== undefined) {
        const next = resolveOne(inner, resolvedFileName, ts.ModuleKind.CommonJS, redirected, hops + 1);
        if (next.resolvedModule && isSource(resolve(next.resolvedModule.resolvedFileName))) return next;
      }
    }
    if (!twin) return result;
    return { ...result, resolvedModule: { ...found, resolvedFileName, extension, isExternalLibraryImport: false } };
  };
  return (literals, containingFile, redirected, opts, containingSourceFile) =>
    literals.map((literal) => resolveOne(literal.text, containingFile, ts.getModeForUsageLocation(containingSourceFile, literal, opts), redirected, 0));
}

export function createSemanticProject(index: SyntacticIndex, scope?: ProgramScope): SemanticProject {
  const started = performance.now();
  const { project } = index;
  const fileNames = scope?.rootNames ?? project.fileNames;
  const options = scope?.options ?? project.options;
  const snapshots = new Map<string, ts.IScriptSnapshot | undefined>();
  const currentDirectory = scope?.currentDirectory ?? (project.tsconfig ? dirname(project.tsconfig) : index.root);
  const indexed = new Set(index.files);
  const system = tsSystem();
  sourceFs().prefetch(fileNames);

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => fileNames,
    getScriptVersion: () => "1",
    getScriptSnapshot(file) {
      if (!snapshots.has(file)) {
        const text = indexed.has(file) ? index.text(file) : system.readFile(file);
        snapshots.set(file, text === undefined ? undefined : ts.ScriptSnapshot.fromString(text));
      }
      return snapshots.get(file);
    },
    getCurrentDirectory: () => currentDirectory,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: system.fileExists,
    readFile: system.readFile,
    readDirectory: system.readDirectory,
    directoryExists: system.directoryExists,
    getDirectories: system.getDirectories,
    ...(system.realpath ? { realpath: system.realpath } : {}),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    resolveModuleNameLiterals: createModuleResolver(options, currentDirectory, (f) => indexed.has(f), (f) => index.sourceFile(f)),
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const program = service.getProgram();
  if (!program) throw new Error("TypeScript did not create a program");

  const inProject = (file: string): boolean =>
    !file.split(/[\\/]/).includes("node_modules") && !program.isSourceFileDefaultLibrary(program.getSourceFile(file)!) &&
    resolve(file).startsWith(index.root);
  const projectFiles = program
    .getSourceFiles()
    .map((sf) => sf.fileName)
    .filter((f) => inProject(f) && !/\.d\.[mc]?ts$/.test(f));

  const location = (fileName: string, start: number): Location | undefined => {
    const sf = program.getSourceFile(fileName);
    if (!sf || !inProject(fileName)) return undefined;
    const lc = sf.getLineAndCharacterOfPosition(start);
    return { file: index.rel(resolve(fileName)), line: lc.line + 1, col: lc.character + 1 };
  };

  const callerName = (item: ts.CallHierarchyItem): string => {
    if (item.kind === ts.ScriptElementKind.scriptElement || item.kind === ts.ScriptElementKind.moduleElement && item.name.includes("/")) {
      return "(top-level)";
    }
    return item.containerName && item.kind !== ts.ScriptElementKind.functionElement ? `${item.containerName}.${item.name}` : item.name;
  };

  const toCallSites = (calls: readonly ts.CallHierarchyIncomingCall[]): CallSite[] => {
    const sites: CallSite[] = [];
    for (const call of calls) {
      for (const span of call.fromSpans) {
        const loc = location(call.from.file, span.start);
        if (loc) sites.push({ ...loc, caller: callerName(call.from), item: call.from });
      }
    }
    return sites;
  };

  const checker = program.getTypeChecker();

  /** Deepest node whose span holds `pos`. */
  const nodeAt = (sf: ts.SourceFile, pos: number): ts.Node => {
    let node: ts.Node = sf;
    for (;;) {
      const child: ts.Node | undefined = ts.forEachChild(node, (c) => (c.getStart(sf) <= pos && pos < c.end ? c : undefined));
      if (!child) return node;
      node = child;
    }
  };

  type Member = ts.MethodDeclaration | ts.MethodSignature | ts.PropertyDeclaration | ts.PropertySignature | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.PropertyAssignment;
  const isMemberNode = (node: ts.Node): node is Member =>
    ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isPropertyAssignment(node);
  const isTypeContainer = (node: ts.Node): node is ts.ClassLikeDeclaration | ts.InterfaceDeclaration =>
    ts.isClassLike(node) || ts.isInterfaceDeclaration(node);

  const memberAt = (fileName: string, pos: number): Member | undefined => {
    const sf = program.getSourceFile(fileName);
    if (!sf) return undefined;
    const parent = nodeAt(sf, pos).parent;
    return parent && isMemberNode(parent) && parent.name.getStart(sf) === pos ? parent : undefined;
  };
  const memberKey = (member: ts.Declaration & { name: ts.PropertyName }): string =>
    `${resolve(member.getSourceFile().fileName)}#${member.name.getStart(member.getSourceFile())}`;
  const memberName = (member: Member): string => {
    const owner = member.parent;
    const ownerName = isTypeContainer(owner) && owner.name ? owner.name.text
      : ts.isObjectLiteralExpression(owner) && ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name) ? owner.parent.name.text
        : "(object)";
    return `${ownerName}.${member.name.getText(member.getSourceFile())}`;
  };

  /** Keys of every member `member` implements or overrides, through extends/implements (transitively) or an object literal's contextual type. */
  const basesOf = (member: Member): string[] => {
    if (ts.isPrivateIdentifier(member.name)) return [];
    const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name) ? member.name.text : undefined;
    if (name === undefined) return [];
    const keys = new Set<string>();
    const seen = new Set<ts.Node>();
    const fromType = (type: ts.Type): void => {
      for (const decl of checker.getPropertyOfType(type, name)?.declarations ?? []) {
        if (decl !== member && isMemberNode(decl)) keys.add(memberKey(decl));
      }
      for (const decl of type.getSymbol()?.declarations ?? []) if (isTypeContainer(decl)) fromHeritage(decl);
    };
    const fromHeritage = (container: ts.ClassLikeDeclaration | ts.InterfaceDeclaration): void => {
      if (seen.has(container)) return;
      seen.add(container);
      for (const clause of container.heritageClauses ?? []) for (const t of clause.types) fromType(checker.getTypeAtLocation(t));
    };
    const owner = member.parent;
    if (isTypeContainer(owner)) fromHeritage(owner);
    else if (ts.isObjectLiteralExpression(owner)) {
      const contextual = checker.getContextualType(owner);
      if (contextual) fromType(contextual);
    }
    return [...keys];
  };

  interface RawRef extends RefDescriptor {
    entry: ReferenceEntry;
    absFile: string;
    start: number;
  }

  /**
   * The same-named top-level Declaration in the `.d.ts` beside a JS file, when that `.d.ts` is in the
   * program: importers the resolver did not redirect (a package.json `types` field) bind to it.
   */
  const declarationTwin = (absFile: string, pos: number): { file: string; pos: number } | undefined => {
    if (!/\.[mc]?jsx?$/.test(absFile)) return undefined;
    const sf = program.getSourceFile(absFile);
    const id = sf ? nodeAt(sf, pos) : undefined;
    if (!id || !ts.isIdentifier(id)) return undefined;
    const base = absFile.replace(/\.([mc]?)jsx?$/, "");
    const twin = [".d.ts", ".d.mts", ".d.cts"].map((ext) => program.getSourceFile(base + ext)).find((t) => t !== undefined);
    if (!twin) return undefined;
    for (const statement of twin.statements) {
      const names = ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map((d) => d.name)
        : "name" in statement && statement.name ? [statement.name as ts.Node] : [];
      const hit = names.find((n) => ts.isIdentifier(n) && n.text === id.text);
      if (hit) return { file: twin.fileName, pos: hit.getStart(twin) };
    }
    return undefined;
  };

  const split = (absFile: string, pos: number): { result: ReferenceSplit; raw: Map<string, RawRef>; buckets: Map<string, "direct" | "via" | "dropped"> } => {
    const twin = declarationTwin(absFile, pos);
    const groups = [...(service.findReferences(absFile, pos) ?? []), ...(twin ? service.findReferences(twin.file, twin.pos) ?? [] : [])];
    const descriptors: Array<GroupDescriptor<RawRef>> = [];
    let target = -1;
    let flagged = -1;
    for (const group of groups) {
      const def = group.definition;
      const member = memberAt(def.fileName, def.textSpan.start);
      const bases = member ? basesOf(member) : [];
      const typeMember = member !== undefined && (isTypeContainer(member.parent) || bases.length > 0);
      const groupKey = member ? memberKey(member) : `${resolve(def.fileName)}#${def.textSpan.start}`;
      const refs: RawRef[] = [];
      for (const ref of group.references) {
        const loc = location(ref.fileName, ref.textSpan.start);
        const refFile = resolve(ref.fileName);
        if (refFile === resolve(absFile) && ref.textSpan.start <= pos && pos <= ref.textSpan.start + ref.textSpan.length && target < 0) {
          target = descriptors.length;
        }
        if (ref.isDefinition && flagged < 0) flagged = descriptors.length;
        if (!loc) continue;
        const sf = program.getSourceFile(ref.fileName)!;
        const parent = nodeAt(sf, ref.textSpan.start).parent;
        refs.push({
          key: `${loc.file}:${loc.line}:${loc.col}`,
          isDefinition: ref.isDefinition ?? false,
          atDefinition: `${refFile}#${ref.textSpan.start}` === groupKey,
          isSuper: parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression.kind === ts.SyntaxKind.SuperKeyword,
          entry: { ...loc, isDefinition: ref.isDefinition ?? false, isWrite: ref.isWriteAccess },
          absFile: refFile,
          start: ref.textSpan.start,
        });
      }
      descriptors.push({ key: groupKey, name: member ? memberName(member) : def.name, member: typeMember, bases, refs });
    }
    const index = target >= 0 ? target : Math.max(0, flagged);
    const c = classifyReferenceGroups(descriptors, index);
    const raw = new Map<string, RawRef>();
    const buckets = new Map<string, "direct" | "via" | "dropped">();
    for (const d of descriptors) for (const r of d.refs) raw.set(r.key, r);
    for (const r of [...c.direct, ...c.declarations]) buckets.set(r.key, "direct");
    for (const v of c.via) buckets.set(v.ref.key, "via");
    for (const r of [...c.dropped, ...c.implementations.map((i) => i.ref)]) buckets.set(r.key, "dropped");
    return {
      result: {
        direct: c.direct.map((r) => r.entry),
        declarations: c.declarations.map((r) => ({ ...r.entry, isDefinition: true })),
        via: c.via.map((v) => ({ ...v.ref.entry, via: v.via, through: v.through })),
        implementations: c.implementations.map((i) => ({ ...i.ref.entry, name: i.name })),
        dropped: c.dropped.map((r) => r.entry),
        bases: c.bases,
      },
      raw,
      buckets,
    };
  };

  /** Call sites keyed against the reference split: direct and via kept, sibling calls dropped. */
  const splitSites = (absFile: string, pos: number, calls: readonly ts.CallHierarchyIncomingCall[]): CallSite[] => {
    const { result, raw, buckets } = split(absFile, pos);
    const viaOf = new Map<string, ViaEntry>(result.via.map((v) => [`${v.file}:${v.line}:${v.col}`, v]));
    const sites: CallSite[] = [];
    for (const call of calls) {
      for (const span of call.fromSpans) {
        const loc = location(call.from.file, span.start);
        if (!loc) continue;
        const file = resolve(call.from.file);
        const hits = [...raw.values()].filter((r) => r.absFile === file && span.start <= r.start && r.start <= span.start + span.length);
        const kinds = hits.map((h) => buckets.get(h.key));
        if (kinds.length > 0 && !kinds.includes("direct") && !kinds.includes("via")) continue;
        const viaHit = kinds.includes("direct") ? undefined : hits.find((h) => viaOf.has(h.key));
        sites.push({ ...loc, caller: callerName(call.from), item: call.from, ...(viaHit ? { via: viaOf.get(viaHit.key)!.via, through: viaOf.get(viaHit.key)!.through } : {}) });
      }
    }
    return sites;
  };

  return {
    index,
    service,
    program,
    projectFiles,
    findReferences(absFile, pos) {
      const { result } = split(absFile, pos);
      return [...result.declarations, ...result.direct];
    },
    referenceSplit(absFile, pos) {
      return split(absFile, pos).result;
    },
    definitionAt(absFile, pos) {
      const defs = service.getDefinitionAtPosition(absFile, pos) ?? [];
      const def = defs.find((d) => location(d.fileName, d.textSpan.start)) ?? defs[0];
      if (!def) return undefined;
      const loc = location(def.fileName, def.textSpan.start) ?? { file: def.fileName, line: 0, col: 0 };
      return { ...loc, name: def.name, kind: def.kind, containerName: def.containerName, absFile: def.fileName, pos: def.textSpan.start };
    },
    incomingCalls(absFile, pos) {
      const prepared = service.prepareCallHierarchy(absFile, pos);
      const items = prepared === undefined ? [] : Array.isArray(prepared) ? prepared : [prepared];
      if (items.length === 0) return undefined;
      const twin = declarationTwin(absFile, pos);
      const twinCalls = twin ? service.provideCallHierarchyIncomingCalls(twin.file, twin.pos) : [];
      const seen = new Set<string>();
      return items
        .flatMap((item) => splitSites(item.file, item.selectionSpan.start, [...service.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start), ...twinCalls]))
        .filter((site) => {
          const key = `${site.file}:${site.line}:${site.col}`;
          return !seen.has(key) && Boolean(seen.add(key));
        });
    },
    incomingCallsOf(item) {
      if (item.kind === ts.ScriptElementKind.scriptElement) return [];
      return toCallSites(service.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start));
    },
    quickInfo(absFile, pos) {
      return service.getQuickInfoAtPosition(absFile, pos);
    },
    diagnosticsCount(touched = []) {
      // A subgraph program mixes projects under one set of options: count the touched files only.
      const files = !scope && projectFiles.length <= FULL_DIAGNOSTICS_LIMIT ? projectFiles : touched.map((f) => index.abs(f));
      let count = 0;
      for (const file of files) {
        const sf = program.getSourceFile(file);
        if (!sf) continue;
        count += program.getSyntacticDiagnostics(sf).length + program.getSemanticDiagnostics(sf).length;
      }
      return count;
    },
    elapsedMs: () => Math.round(performance.now() - started),
  };
}

export interface ProjectContext {
  cwd: string;
  root: string;
  location: TsconfigLocation;
  index: SyntacticIndex;
  warning?: string;
}

/** The workspace as one file set; each semantic command scopes its own program from it. */
function scopedProject(root: string, workspace: Workspace, implicit: boolean): ParsedProject {
  return {
    root,
    tsconfig: null,
    implicit,
    fileNames: workspace.sourceFiles,
    options: IMPLICIT_COMPILER_OPTIONS,
    scope: { workspace, kind: implicit ? "implicit" : workspace.kind },
  };
}

/**
 * Repo root + tsconfig discovery + syntactic index in one call. Without `-P` / `.ts-axi.json`
 * `project`, a multi-project workspace (or a large implicit project) becomes one scoped file set.
 */
export function openProject(
  cwd: string,
  options: { startDir?: string; override?: string; settingsProject?: string; settingsRoot?: string } = {},
): ProjectContext {
  const root = findRepoRoot(cwd);
  const location = discoverTsconfig(options.startDir ?? cwd, {
    cwd,
    ...(options.override ? { override: options.override } : {}),
    ...(options.settingsProject ? { settingsProject: options.settingsProject } : {}),
    settingsRoot: options.settingsRoot ?? root,
    ...(sourceFs().ref || sourceFs().exists(join(root, ".git")) ? { stopAt: root } : {}),
  });
  const explicit = options.override !== undefined || options.settingsProject !== undefined;
  let project: ParsedProject | undefined;
  if (!explicit && (location.implicit || hasMultiProjectSignal(root))) {
    const workspace = detectWorkspace(root);
    if (isMultiProject(workspace.kind)) project = scopedProject(root, workspace, false);
    else if (location.implicit && workspace.sourceFiles.length > IMPLICIT_SCOPE_THRESHOLD) project = scopedProject(root, workspace, true);
  }
  project ??= loadProject(root, location);
  const index = createSyntacticIndex(root, project);
  return { cwd, root, location, index, ...(project.implicit ? { warning: IMPLICIT_WARNING } : {}) };
}
