import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { expectPositionals, flag, flags, parseArgs } from "../args.js";
import type { CommandContext } from "../context.js";
import { AxiError, usageError } from "../errors.js";
import { currentBranch, dirtyFileCount, isGitRepo } from "../git.js";
import { block, helpBlock, out } from "../render.js";
import { SETTINGS_FILE, isTestFile, loadSettings, readSettingsFile, type Settings } from "../settings.js";
import { listFiles, skipDir } from "../walk.js";
import { detectWorkspace, hasMultiProjectSignal, isMultiProject, type Workspace } from "../workspace.js";

const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** The view runs at session start: bound the file walk by count and time. */
const WALK_CAP = 20_000;
const WALK_DEADLINE_MS = 600;
const PROBE_DEPTH = 3;

const HOME_SPECS = [
  { name: "--test-glob", repeatable: true },
  { name: "--project", alias: "-P" },
] as const;

interface Counted {
  files: string[];
  capped: boolean;
}

/** Does `dir` hold a TS/JS source within `depth` levels (shared skip rule)? */
function hasSources(dir: string, depth: number, root = dir): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && SOURCE_EXT.test(entry.name)) return true;
  }
  if (depth === 0) return false;
  return entries.some((e) => e.isDirectory() && !skipDir(e.name, join(dir, e.name), root) && hasSources(join(dir, e.name), depth - 1, root));
}

/** Implicit project: every source below `root` from the shared listing (git, else a bounded fs walk). */
function walkSources(root: string): Counted {
  return listFiles(root, (name) => SOURCE_EXT.test(name) && !/\.d\.[mc]?ts$/.test(name), { maxFiles: WALK_CAP, deadline: Date.now() + WALK_DEADLINE_MS });
}

function findTsconfig(cwd: string): string | undefined {
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function tsconfigFiles(tsconfig: string, root: string): Promise<Counted & { referenced?: number }> {
  // Loaded lazily: the TypeScript module is only needed when a tsconfig exists.
  const { loadProject } = await import("../project.js");
  try {
    const project = loadProject(root, { path: tsconfig, implicit: false });
    return { files: project.fileNames, capped: false, ...(project.referenced !== undefined ? { referenced: project.referenced } : {}) };
  } catch {
    return { files: [], capped: false };
  }
}

function rel(root: string, path: string): string {
  return relative(root, path).split(sep).join("/") || ".";
}

async function gitSummary(cwd: string): Promise<{ text: string; dirty: number; branch: string | undefined }> {
  try {
    if (!(await isGitRepo(cwd))) return { text: "none", dirty: 0, branch: undefined };
    const [branch, dirty] = await Promise.all([currentBranch(cwd), dirtyFileCount(cwd)]);
    return { text: `${branch ?? "unknown"} (${dirty} dirty)`, dirty, branch: branch ?? undefined };
  } catch {
    return { text: "none", dirty: 0, branch: undefined };
  }
}

function resolveTsconfig(cwd: string, settings: Settings): string | undefined {
  if (settings.project !== undefined) {
    // -P is relative to cwd, the .ts-axi.json value to the repo root.
    const base = settings.sources.project === "flag" ? cwd : settings.root;
    const path = resolve(base, settings.project);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw usageError(`tsconfig not found: ${settings.project}`, [
        settings.sources.project === "flag"
          ? "Pass an existing file to -P"
          : `Run \`ts-axi config set project <tsconfig>\` or \`ts-axi config unset project\` to fix ${SETTINGS_FILE}`,
      ]);
    }
    return path;
  }
  return findTsconfig(cwd);
}

export async function homeCommand(args: string[], ctx?: CommandContext): Promise<string> {
  const parsed = parseArgs(args, HOME_SPECS, "ts-axi");
  expectPositionals(parsed, 0, "ts-axi [-P <tsconfig>] [--test-glob <glob>]");
  const cwd = ctx?.cwd ?? process.cwd();
  const project = flag(parsed, "--project");
  const overrides = { testGlobs: flags(parsed, "--test-glob"), ...(project !== undefined ? { project } : {}) };
  // A broken .ts-axi.json must not fail the session-start view: report it and carry on without the file.
  let broken: string | undefined;
  let settings: Settings;
  try {
    settings = loadSettings(cwd, overrides);
  } catch (error) {
    if (!(error instanceof AxiError)) throw error;
    broken = error.message;
    settings = loadSettings(cwd, { ...overrides, ignoreFile: true });
  }
  let tsconfig: string | undefined;
  try {
    tsconfig = resolveTsconfig(cwd, settings);
  } catch (error) {
    if (!(error instanceof AxiError) || settings.sources.project !== SETTINGS_FILE) throw error;
    broken = error.message;
    settings = loadSettings(cwd, { ...overrides, ignoreFile: true });
    tsconfig = resolveTsconfig(cwd, settings);
  }
  // Same rule as the semantic commands: no explicit project + a multi-project workspace = workspace scope.
  let workspace: Workspace | undefined;
  if (settings.project === undefined && (tsconfig === undefined || hasMultiProjectSignal(settings.root))) {
    const detected = detectWorkspace(settings.root);
    if (isMultiProject(detected.kind)) workspace = detected;
  }
  if (tsconfig === undefined && workspace === undefined && !hasSources(cwd, PROBE_DEPTH)) {
    return out(
      block({ project: "none" }),
      helpBlock([
        "Run `ts-axi outline <file>` on any .ts/.js file; it needs no project",
        "Run `ts-axi --help` for all commands",
      ]),
    );
  }

  const [git, counted] = await Promise.all([
    gitSummary(cwd),
    workspace
      ? Promise.resolve<Counted & { referenced?: number }>({ files: workspace.sourceFiles, capped: false })
      : tsconfig !== undefined ? tsconfigFiles(tsconfig, settings.root) : Promise.resolve<Counted & { referenced?: number }>(walkSources(settings.root)),
  ]);
  const testFiles = counted.files.filter((f) => isTestFile(rel(settings.root, f), settings)).length;
  const plus = counted.capped ? "+" : "";
  const present = broken === undefined && readSettingsFile(settings.root) !== undefined;

  const onDefaultBranch = git.branch === undefined || git.branch === "main" || git.branch === "master";
  const help: string[] = [];
  if (broken !== undefined) help.push(`Fix or delete ${SETTINGS_FILE} - def, refs, callers, impact and config refuse to run until then (outline still works)`);
  if (broken === undefined && (git.dirty > 0 || !onDefaultBranch)) {
    help.push("Run `ts-axi impact` to see which other code your changes affect");
  }
  help.push(
    "Run `ts-axi outline <file>` to list the declarations in a file",
    ...(broken === undefined
      ? ["Run `ts-axi def <name>` to find where a symbol is declared", "Run `ts-axi config` to see or change the test-file globs"]
      : []),
    "Run `ts-axi --help` for all commands",
  );

  return out(
    block({
      root: settings.root,
      ...(workspace ? { workspace: `${workspace.kind} (${workspace.projects.length} projects)` } : {}),
      tsconfig: workspace
        ? "nearest per file - workspace scope"
        : tsconfig === undefined
          ? "implicit"
          : `${rel(settings.root, tsconfig)}${counted.referenced !== undefined ? ` (${counted.referenced} referenced configs)` : ""}`,
      source_files: counted.capped ? `${counted.files.length}${plus}` : counted.files.length,
      test_globs: settings.testGlobs.length,
      test_files: counted.capped ? `${testFiles}${plus}` : testFiles,
      git: git.text,
      settings: broken !== undefined ? `${SETTINGS_FILE} (ignored - ${/not valid JSON/.test(broken) ? "not valid JSON" : broken.replace(`${SETTINGS_FILE} `, "")})` : `${SETTINGS_FILE} (${present ? "present" : "absent"})`,
    }),
    helpBlock(help),
  );
}
