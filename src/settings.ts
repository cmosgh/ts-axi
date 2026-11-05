// Per-repo settings (`.ts-axi.json`) and test-file matching. Shared by every
// command; the `config` command is the only writer.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { usageError } from "./errors.js";
import { matchesGlob } from "./glob.js";

export const DEFAULT_TEST_GLOBS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
  "**/e2e/**",
  "**/spec/**",
  "**/test.*",
  "**/*_test.*",
];

export const SETTINGS_FILE = ".ts-axi.json";
export const SETTINGS_KEYS = ["testGlobs", "testGlobsReplace", "project"] as const;

export type SettingSource = "default" | ".ts-axi.json" | "flag";

export interface Settings {
  /** Directory holding `.ts-axi.json` (git root, or cwd outside a repo). */
  root: string;
  /** Effective test globs: defaults + file (or file only when replaced) + flags. */
  testGlobs: string[];
  testGlobsReplace: boolean;
  /** Relative tsconfig path from `.ts-axi.json` `project`, if any. */
  project?: string;
  sources: { testGlobs: SettingSource[]; project: SettingSource };
}

export interface SettingsOverrides {
  /** `--test-glob` values, additive. */
  testGlobs?: string[];
  /** `-P <tsconfig>`. */
  project?: string;
  /** Skip `.ts-axi.json`: the home view still renders when the file is broken. */
  ignoreFile?: boolean;
}

/** Contents of `.ts-axi.json`; every key optional. */
export interface SettingsFile {
  testGlobs?: string[];
  testGlobsReplace?: boolean;
  project?: string;
}

/** Nearest directory with `.git` (dir or worktree file) walking up from `cwd`, else `cwd`. */
export function findRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

function invalidKeys(): string[] {
  return [`valid keys: ${SETTINGS_KEYS.join(", ")}`];
}

function validate(data: unknown): SettingsFile {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw usageError(`${SETTINGS_FILE} must contain a JSON object`, invalidKeys());
  }
  const record = data as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => !(SETTINGS_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw usageError(
      `${SETTINGS_FILE}: unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `'${k}'`).join(", ")}`,
      invalidKeys(),
    );
  }
  const { testGlobs, testGlobsReplace, project } = record;
  if (
    testGlobs !== undefined &&
    !(Array.isArray(testGlobs) && testGlobs.every((g) => typeof g === "string" && g !== ""))
  ) {
    throw usageError(`${SETTINGS_FILE}: 'testGlobs' must be an array of non-empty strings`, invalidKeys());
  }
  if (testGlobsReplace !== undefined && typeof testGlobsReplace !== "boolean") {
    throw usageError(`${SETTINGS_FILE}: 'testGlobsReplace' must be a boolean`, invalidKeys());
  }
  if (project !== undefined && (typeof project !== "string" || project === "")) {
    throw usageError(`${SETTINGS_FILE}: 'project' must be a non-empty string`, invalidKeys());
  }
  return record as SettingsFile;
}

/** The validated file at `<root>/.ts-axi.json`, or `undefined` when absent. */
export function readSettingsFile(root: string): SettingsFile | undefined {
  const path = join(root, SETTINGS_FILE);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw usageError(`${SETTINGS_FILE} is not valid JSON: ${(error as Error).message}`, invalidKeys());
  }
  return validate(parsed);
}

export function writeSettingsFile(root: string, data: SettingsFile): void {
  validate(data);
  writeFileSync(join(root, SETTINGS_FILE), `${JSON.stringify(data, null, 2)}\n`);
}

export function loadSettings(cwd: string, overrides: SettingsOverrides = {}): Settings {
  const root = findRoot(cwd);
  const file = overrides.ignoreFile ? undefined : readSettingsFile(root);

  const fileGlobs = file?.testGlobs ?? [];
  // An empty list cannot replace the defaults: that would turn every file into a non-test.
  const replace = file?.testGlobsReplace === true && fileGlobs.length > 0;

  const testGlobs: string[] = [];
  const globSources: SettingSource[] = [];
  const add = (globs: readonly string[], source: SettingSource): void => {
    for (const glob of globs) {
      if (testGlobs.includes(glob)) continue;
      testGlobs.push(glob);
      globSources.push(source);
    }
  };
  if (!replace) add(DEFAULT_TEST_GLOBS, "default");
  add(fileGlobs, ".ts-axi.json");
  add(overrides.testGlobs ?? [], "flag");

  const project = overrides.project ?? file?.project;
  const projectSource: SettingSource =
    overrides.project !== undefined ? "flag" : file?.project !== undefined ? ".ts-axi.json" : "default";

  return {
    root,
    testGlobs,
    testGlobsReplace: file?.testGlobsReplace === true,
    ...(project !== undefined ? { project } : {}),
    sources: { testGlobs: globSources, project: projectSource },
  };
}

/** `path` is repo-root-relative with `/` separators. */
export function isTestFile(path: string, settings: Settings): boolean {
  return settings.testGlobs.some((glob) => matchesGlob(path, glob));
}
