// Scoped program for semantic commands in a workspace: seed files + their importers (syntactic
// importer index), compiled with the seed's own tsconfig plus the workspace `paths`.
import { dirname, join } from "node:path";
import { sourceFs } from "./fs.js";
import ts from "typescript";
import { buildImporterIndex, createResolver, importerClosure, type ImporterIndex } from "./importers.js";
import {
  createSemanticProject,
  expandTsconfig,
  IMPLICIT_COMPILER_OPTIONS,
  nearestTsconfig,
  type ProgramScope,
  type ProjectContext,
  type SemanticProject,
  type SyntacticIndex,
} from "./project.js";
import { IMPORTER_MAX_FILES, IMPORTER_MAX_MS } from "./importers.js";
import { kindLabel, readJsonc, type Workspace } from "./workspace.js";

export interface ScopeInfo {
  /** `nx workspace - 23 of 9612 files (seeds 1; importers 22)`. */
  line: string;
  partial: boolean;
  scanned: number;
  total: number;
}

/** Importer hops: refs/callers need the declaring file's importers (barrels free), impact two levels. */
export const REFS_HOPS = 1;
export const IMPACT_HOPS = 2;

const indexes = new WeakMap<Workspace, Map<string, ImporterIndex>>();

/** The workspace importer index (in memory for this process only); `extra` = paths that resolve although absent (deleted files). */
export function importerIndexFor(index: SyntacticIndex, workspace: Workspace, extra: readonly string[] = []): ImporterIndex {
  const key = [...extra].sort().join("\n");
  let byKey = indexes.get(workspace);
  if (!byKey) indexes.set(workspace, (byKey = new Map()));
  let built = byKey.get(key);
  if (!built) {
    const resolveSpec = createResolver(workspace, new Set([...workspace.sourceFiles, ...extra]));
    sourceFs().prefetch(workspace.sourceFiles);
    built = buildImporterIndex(workspace.sourceFiles, (f) => index.text(f), resolveSpec, { maxFiles: IMPORTER_MAX_FILES, maxMs: IMPORTER_MAX_MS });
    byKey.set(key, built);
  }
  return built;
}

/** Options that would make a subgraph program error on files outside one project's layout. */
const DROPPED_OPTIONS = ["composite", "incremental", "tsBuildInfoFile", "rootDir", "rootDirs", "outDir", "outFile", "declaration", "declarationMap", "emitDeclarationOnly", "sourceMap"];

/** The seed's nearest tsconfig (its referenced config that includes the seed, for a references-only shell) + workspace `paths`. */
export function compilerOptionsFor(seed: string, workspace: Workspace): ts.CompilerOptions {
  let options: ts.CompilerOptions | undefined;
  const tsconfig = nearestTsconfig(seed, workspace.root);
  if (tsconfig) {
    const configs = expandTsconfig(tsconfig);
    const picked = (configs.find((c) => c.fileNames.includes(seed)) ?? configs[0])?.options;
    // Importers include spec files: give them the spec config's globals too.
    const types = configs.some((c) => c.options.types === undefined) ? undefined : [...new Set(configs.flatMap((c) => c.options.types ?? []))];
    options = picked && types ? { ...picked, types } : picked;
  }
  if (!options) {
    const base = join(workspace.root, "tsconfig.base.json");
    const raw = sourceFs().exists(base) ? readJsonc(base)?.["compilerOptions"] : undefined;
    options = raw ? { ...IMPLICIT_COMPILER_OPTIONS, ...ts.convertCompilerOptionsFromJson(raw, dirname(base), base).options } : { ...IMPLICIT_COMPILER_OPTIONS };
  }
  const merged: ts.CompilerOptions = { ...options, noEmit: true, skipLibCheck: true };
  for (const key of DROPPED_OPTIONS) delete merged[key];
  if (!merged.paths && workspace.paths) {
    merged.paths = workspace.paths.paths;
    // Internal option TypeScript sets from the tsconfig that declares `paths`; avoids the deprecated baseUrl.
    merged["pathsBasePath"] = workspace.paths.base;
  }
  // Workspace packages resolve to their sources, not to a built `dist` behind a node_modules link.
  const resolveSpec = createResolver({ packages: workspace.packages }, new Set(workspace.sourceFiles));
  const packagePaths: Record<string, string[]> = {};
  for (const pkg of workspace.packages) {
    for (const sub of Object.keys(pkg.exports)) {
      if (sub.includes("*")) continue;
      const spec = sub === "." ? pkg.name : `${pkg.name}/${sub.slice(2)}`;
      if (merged.paths?.[spec]) continue;
      const target = resolveSpec(spec, workspace.root);
      if (target) packagePaths[spec] = [target];
    }
  }
  if (Object.keys(packagePaths).length > 0) {
    if (!merged.paths) merged["pathsBasePath"] = workspace.root;
    merged.paths = { ...packagePaths, ...merged.paths };
  }
  return merged;
}

/** Root files and options of the subgraph program around `seeds`. */
export function planScope(
  index: SyntacticIndex,
  seeds: readonly string[],
  hops: number,
  extra: readonly string[] = [],
): { program: ProgramScope; info: ScopeInfo } {
  const scope = index.project.scope!;
  const { workspace } = scope;
  const importers = hops > 0 ? importerIndexFor(index, workspace, extra) : undefined;
  const closure = importers ? importerClosure(importers, [...seeds, ...extra], hops) : { importers: [], barrels: [] };
  const seedFiles = seeds.filter((s) => sourceFs().exists(s));
  const rootNames = [...new Set([...seedFiles, ...closure.importers])];
  const options = compilerOptionsFor(seedFiles[0] ?? seeds[0] ?? join(workspace.root, "index.ts"), workspace);
  if (rootNames.some((f) => /\.[mc]?jsx?$/.test(f))) {
    options.allowJs = true;
    options.checkJs = false;
  }
  return {
    program: { rootNames, options, currentDirectory: workspace.root },
    info: {
      line: `${kindLabel(scope.kind)} - ${rootNames.length} of ${workspace.sourceFiles.length} files (seeds ${seedFiles.length}; importers ${closure.importers.length})`,
      partial: importers?.partial ?? false,
      scanned: importers?.scanned ?? 0,
      total: workspace.sourceFiles.length,
    },
  };
}

/** A LanguageService over the Project, or over the importer subgraph of `seeds` when the Project is scoped. */
export function semanticFor(
  ctx: ProjectContext,
  seeds: readonly string[],
  hops: number,
  extra: readonly string[] = [],
): { semantic: SemanticProject; scope?: ScopeInfo } {
  if (!ctx.index.project.scope) {
    // A seed the tsconfig leaves out (an excluded dir) joins the Project's roots, or the service cannot see it.
    const known = new Set(ctx.index.files);
    const outside = seeds.filter((s) => !known.has(s) && sourceFs().exists(s));
    if (outside.length === 0) return { semantic: createSemanticProject(ctx.index) };
    const { project } = ctx.index;
    return {
      semantic: createSemanticProject(ctx.index, {
        rootNames: [...project.fileNames, ...new Set(outside)],
        options: project.options,
        currentDirectory: project.tsconfig ? dirname(project.tsconfig) : ctx.index.root,
      }),
    };
  }
  const { program, info } = planScope(ctx.index, seeds, hops, extra);
  return { semantic: createSemanticProject(ctx.index, program), scope: info };
}

/** `scope` / `scope_partial` fields for a semantic command's output. */
export function scopeFields(scope: ScopeInfo | undefined): Record<string, unknown> {
  if (!scope) return {};
  return { scope: scope.line, ...(scope.partial ? { scope_partial: true } : {}) };
}

/** Help line when the importer scan stopped early. */
export function scopeHelp(scope: ScopeInfo | undefined): string[] {
  if (!scope?.partial) return [];
  return [
    `Importer scan stopped after ${scope.scanned} of ${scope.total} files (cap ${IMPORTER_MAX_FILES} files or ${IMPORTER_MAX_MS / 1000} s) - importers in the rest are missing; run with -P <tsconfig> for one whole project`,
  ];
}
