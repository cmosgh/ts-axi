// Per-repo settings (`.ts-axi.json`) and test-file matching. Shared by every
// command; the `config` command is the only writer.

export const DEFAULT_TEST_GLOBS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
  "**/e2e/**",
];

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
}

// Implemented in phase 2 (see PLAN.md). Stubs keep the tree compiling while
// the engine and the settings work proceed in parallel.
export function loadSettings(_cwd: string, _overrides: SettingsOverrides = {}): Settings {
  throw new Error("loadSettings: not implemented");
}

/** `path` is repo-root-relative with `/` separators. */
export function isTestFile(_path: string, _settings: Settings): boolean {
  throw new Error("isTestFile: not implemented");
}
