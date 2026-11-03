import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { expectPositionals, flag, flags, parseArgs } from "../args.js";
import { usageError } from "../errors.js";
import { currentBranch, dirtyFileCount, isGitRepo } from "../git.js";
import { block, helpBlock, out } from "../render.js";
import { SETTINGS_FILE, isTestFile, loadSettings, readSettingsFile, type Settings } from "../settings.js";

const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);
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

/** Does `dir` hold a TS/JS source within `depth` levels (node_modules skipped)? */
function hasSources(dir: string, depth: number): boolean {
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
  return entries.some(
    (e) => e.isDirectory() && e.name !== "node_modules" && e.name !== ".git" && hasSources(join(dir, e.name), depth - 1),
  );
}

/** Implicit project: every source below `root`, minus node_modules, dist, build, .git. */
function walkSources(root: string): Counted {
  const files: string[] = [];
  const deadline = Date.now() + WALK_DEADLINE_MS;
  let capped = false;
  const stack = [root];
  while (stack.length > 0 && !capped) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
    if (files.length >= WALK_CAP || Date.now() > deadline) capped = true;
  }
  return { files, capped };
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

async function tsconfigFiles(tsconfig: string): Promise<Counted> {
  const ts = (await import("typescript")).default;
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (read.error) return { files: [], capped: false };
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfig), undefined, tsconfig);
  const files = parsed.fileNames.filter((f) => !f.split(/[\\/]/).includes("node_modules"));
  return { files, capped: false };
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

export async function homeCommand(args: string[]): Promise<string> {
  const parsed = parseArgs(args, HOME_SPECS, "ts-axi");
  expectPositionals(parsed, 0, "ts-axi [-P <tsconfig>] [--test-glob <glob>]");
  const cwd = process.cwd();
  const project = flag(parsed, "--project");
  const settings = loadSettings(cwd, {
    testGlobs: flags(parsed, "--test-glob"),
    ...(project !== undefined ? { project } : {}),
  });

  const tsconfig = resolveTsconfig(cwd, settings);
  if (tsconfig === undefined && !hasSources(cwd, PROBE_DEPTH)) {
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
    tsconfig !== undefined ? tsconfigFiles(tsconfig) : Promise.resolve(walkSources(settings.root)),
  ]);
  const testFiles = counted.files.filter((f) => isTestFile(rel(settings.root, f), settings)).length;
  const plus = counted.capped ? "+" : "";
  const present = readSettingsFile(settings.root) !== undefined;

  const onDefaultBranch = git.branch === undefined || git.branch === "main" || git.branch === "master";
  const help: string[] = [];
  if (git.dirty > 0 || !onDefaultBranch) {
    help.push("Run `ts-axi impact` to see which other code your changes affect");
  }
  help.push(
    "Run `ts-axi outline <file>` to list the declarations in a file",
    "Run `ts-axi def <name>` to find where a symbol is declared",
    "Run `ts-axi config` to see or change the test-file globs",
    "Run `ts-axi --help` for all commands",
  );

  return out(
    block({
      root: settings.root,
      tsconfig: tsconfig === undefined ? "implicit" : rel(settings.root, tsconfig),
      source_files: counted.capped ? `${counted.files.length}${plus}` : counted.files.length,
      test_globs: settings.testGlobs.length,
      test_files: counted.capped ? `${testFiles}${plus}` : testFiles,
      git: git.text,
      settings: `${SETTINGS_FILE} (${present ? "present" : "absent"})`,
    }),
    helpBlock(help),
  );
}
