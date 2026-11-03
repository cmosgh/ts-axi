// Project discovery and the two engine paths (ADR 0001): a syntactic index
// over `ts.createSourceFile`, and a LanguageService for semantic queries.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { usageError } from "./errors.js";
import { collectDeclarations, type Declaration } from "./symbols.js";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] as const;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);

export const IMPLICIT_WARNING = "no tsconfig.json found - implicit project";

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Nearest ancestor of `cwd` (inclusive) holding `.git`, else `cwd`. */
export function findRepoRoot(cwd: string): string {
  const start = real(cwd);
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
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
  const file = existsSync(abs) && statSync(abs).isDirectory() ? join(abs, "tsconfig.json") : abs;
  if (!existsSync(file)) {
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
    if (existsSync(candidate)) return { path: candidate, implicit: false };
    const parent = dirname(dir);
    if (parent === dir || (options.stopAt !== undefined && dir === real(options.stopAt))) return { path: null, implicit: true };
    dir = parent;
  }
}

function isSourceFile(name: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !/\.d\.[mc]?ts$/.test(name);
}

/** Every source file below `root`, minus node_modules/dist/build/.git and `.d.ts`. */
export function walkSourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(join(dir, entry.name));
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
  };
  visit(root);
  return files.sort();
}

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

export interface ParsedProject {
  root: string;
  tsconfig: string | null;
  implicit: boolean;
  /** Absolute source file paths (node_modules excluded). */
  fileNames: string[];
  options: ts.CompilerOptions;
}

/** Resolve the Project's file list and compiler options. Cheap: reads directories, parses no source. */
export function loadProject(root: string, location: TsconfigLocation): ParsedProject {
  if (!location.path) {
    return { root, tsconfig: null, implicit: true, fileNames: walkSourceFiles(root), options: IMPLICIT_COMPILER_OPTIONS };
  }
  const read = ts.readConfigFile(location.path, ts.sys.readFile);
  if (read.error) {
    throw usageError(`cannot read ${location.path} - ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(location.path), undefined, location.path);
  const fileNames = parsed.fileNames
    .map((f) => resolve(f))
    .filter((f) => !f.split(sep).includes("node_modules") && SOURCE_EXTENSIONS.some((ext) => f.endsWith(ext)));
  return { root, tsconfig: location.path, implicit: false, fileNames, options: { ...parsed.options, noEmit: true } };
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
      if (!texts.has(abs)) {
        let text: string | undefined;
        try {
          text = readFileSync(abs, "utf8");
        } catch {
          text = undefined;
        }
        texts.set(abs, text);
      }
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
      const needle = query.fuzzy ? query.name.toLowerCase() : query.name;
      const result: Declaration[] = [];
      for (const file of index.files) {
        const text = index.text(file);
        if (text === undefined) continue;
        if (query.fuzzy ? !text.toLowerCase().includes(needle) : !text.includes(needle)) continue;
        for (const decl of index.declarations(file)) {
          if (query.member !== undefined) {
            if (decl.parentName === undefined) continue;
            const parent = decl.parentName.split(".").pop()!;
            const ok = query.fuzzy
              ? parent.toLowerCase().includes(needle) && decl.name.toLowerCase().includes(query.member.toLowerCase())
              : parent === query.name && decl.name === query.member;
            if (ok) result.push(decl);
          } else if (query.fuzzy ? decl.name.toLowerCase().includes(needle) : decl.name === query.name) {
            result.push(decl);
          }
        }
      }
      return result;
    },
    allNames() {
      const names = new Set<string>();
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
}

export interface SemanticProject {
  index: SyntacticIndex;
  service: ts.LanguageService;
  program: ts.Program;
  /** Program files that belong to the Project (no lib, no node_modules). */
  projectFiles: string[];
  findReferences(absFile: string, pos: number): ReferenceEntry[];
  definitionAt(absFile: string, pos: number): DefinitionInfo | undefined;
  /** Incoming calls of the function-like Symbol at `pos`; undefined when it is not callable. */
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

export function createSemanticProject(index: SyntacticIndex): SemanticProject {
  const started = performance.now();
  const { project } = index;
  const fileNames = project.fileNames;
  const snapshots = new Map<string, ts.IScriptSnapshot | undefined>();
  const currentDirectory = project.tsconfig ? dirname(project.tsconfig) : index.root;

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => project.options,
    getScriptFileNames: () => fileNames,
    getScriptVersion: () => "1",
    getScriptSnapshot(file) {
      if (!snapshots.has(file)) {
        const text = index.files.includes(file) ? index.text(file) : ts.sys.readFile(file);
        snapshots.set(file, text === undefined ? undefined : ts.ScriptSnapshot.fromString(text));
      }
      return snapshots.get(file);
    },
    getCurrentDirectory: () => currentDirectory,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
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

  return {
    index,
    service,
    program,
    projectFiles,
    findReferences(absFile, pos) {
      const groups = service.findReferences(absFile, pos) ?? [];
      const seen = new Set<string>();
      const entries: ReferenceEntry[] = [];
      for (const group of groups) {
        for (const ref of group.references) {
          const loc = location(ref.fileName, ref.textSpan.start);
          if (!loc) continue;
          const key = `${loc.file}:${loc.line}:${loc.col}`;
          if (seen.has(key)) continue;
          seen.add(key);
          entries.push({ ...loc, isDefinition: ref.isDefinition ?? false, isWrite: ref.isWriteAccess });
        }
      }
      return entries;
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
      return items.flatMap((item) => toCallSites(service.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start)));
    },
    incomingCallsOf(item) {
      if (item.kind === ts.ScriptElementKind.scriptElement) return [];
      return toCallSites(service.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start));
    },
    quickInfo(absFile, pos) {
      return service.getQuickInfoAtPosition(absFile, pos);
    },
    diagnosticsCount(touched = []) {
      const files = projectFiles.length <= FULL_DIAGNOSTICS_LIMIT ? projectFiles : touched.map((f) => index.abs(f));
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

/** Repo root + tsconfig discovery + syntactic index in one call. */
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
    ...(existsSync(join(root, ".git")) ? { stopAt: root } : {}),
  });
  const index = createSyntacticIndex(root, loadProject(root, location));
  return { cwd, root, location, index, ...(location.implicit ? { warning: IMPLICIT_WARNING } : {}) };
}
