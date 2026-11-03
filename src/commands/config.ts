import { existsSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { expectPositionals, flags, flag, bool, parseArgs } from "../args.js";
import { usageError } from "../errors.js";
import { block, helpBlock, out } from "../render.js";
import {
  DEFAULT_TEST_GLOBS,
  SETTINGS_FILE,
  findRoot,
  loadSettings,
  readSettingsFile,
  writeSettingsFile,
  type SettingsFile,
} from "../settings.js";

export const CONFIG_HELP = `usage: ts-axi config [set <key> <value>... [--replace] | unset <key>]
Show or change the per-repo settings in ${SETTINGS_FILE} (written at the git root).
keys:
  test-globs (globs that mark Test files; added to the defaults, --replace swaps the defaults out)
  project (tsconfig path relative to the repo root; used when -P is not given)
flags:
  --replace (set test-globs: replace the default globs instead of adding to them)
  --test-glob <glob> (show only: preview extra run-time globs; repeatable)
  -P <tsconfig> (show only: preview a project override)
notes:
  Setting a value that is already in effect is a no-op (exit 0).
examples[4]:
  ts-axi config
  ts-axi config set test-globs '**/*.it.ts' 'packages/*/qa/**'
  ts-axi config set project tsconfig.app.json
  ts-axi config unset test-globs
`;

const KEYS = ["test-globs", "project"] as const;
type Key = (typeof KEYS)[number];

function parseKey(raw: string | undefined, command: string): Key {
  const normalized = raw === "testGlobs" ? "test-globs" : raw;
  if (normalized === undefined) {
    throw usageError("missing key", [`usage: ${command} <key>`, `valid keys: ${KEYS.join(", ")}`]);
  }
  if (!(KEYS as readonly string[]).includes(normalized)) {
    throw usageError(`unknown key '${raw}'`, [`valid keys: ${KEYS.join(", ")}`]);
  }
  return normalized as Key;
}

function fileLabel(present: boolean): string {
  return `${SETTINGS_FILE} (${present ? "present" : "absent"})`;
}

export async function configCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "set") return setCommand(rest);
  if (sub === "unset") return unsetCommand(rest);
  if (sub !== undefined && !sub.startsWith("-")) {
    throw usageError(`unknown config action '${sub}'`, [
      "Run `ts-axi config` to show, `ts-axi config set <key> <value>` or `ts-axi config unset <key>` to change",
    ]);
  }
  return showCommand(args);
}

function showCommand(args: string[]): string {
  const parsed = parseArgs(
    args,
    [{ name: "--test-glob", repeatable: true }, { name: "--project", alias: "-P" }],
    "ts-axi config",
  );
  expectPositionals(parsed, 0, "ts-axi config");
  const cwd = process.cwd();
  const project = flag(parsed, "--project");
  const settings = loadSettings(cwd, {
    testGlobs: flags(parsed, "--test-glob"),
    ...(project !== undefined ? { project } : {}),
  });
  const present = readSettingsFile(settings.root) !== undefined;

  return out(
    block({
      root: settings.root,
      file: fileLabel(present),
      test_globs: settings.testGlobs.map((glob, i) => ({
        glob,
        source: settings.sources.testGlobs[i],
      })),
      ...(settings.testGlobsReplace ? { test_globs_replace: true } : {}),
      project: settings.project ?? "none",
      ...(settings.project !== undefined ? { project_source: settings.sources.project } : {}),
    }),
    helpBlock([
      "Run `ts-axi config set test-globs '<glob>'` to mark more files as tests (add --replace to drop the defaults)",
      "Run `ts-axi config set project <tsconfig>` to pin the tsconfig",
    ]),
  );
}

const AFTER_WRITE = "Run `ts-axi` to see how many files the test globs match";

function setCommand(args: string[]): string {
  const parsed = parseArgs(args, [{ name: "--replace", boolean: true }], "ts-axi config set");
  const [rawKey, ...values] = parsed.positionals;
  const key = parseKey(rawKey, "ts-axi config set");
  const root = findRoot(process.cwd());
  const file: SettingsFile = { ...(readSettingsFile(root) ?? {}) };
  const replace = bool(parsed, "--replace");

  if (key === "project") {
    if (replace) throw usageError("--replace only applies to test-globs");
    if (values.length !== 1) {
      throw usageError(values.length === 0 ? "missing value" : `unexpected argument '${values[1]}'`, [
        "usage: ts-axi config set project <tsconfig-path>",
      ]);
    }
    const project = normalizeProject(root, values[0]!);
    if (file.project === project) {
      return block({ project: `${project} (no-op)`, file: fileLabel(true) });
    }
    writeSettingsFile(root, { ...file, project });
    return out(block({ project, file: fileLabel(true) }), helpBlock([AFTER_WRITE]));
  }

  if (values.length === 0) {
    throw usageError("missing value", ["usage: ts-axi config set test-globs <glob>... [--replace]"]);
  }
  const requested = [...new Set(values)];

  if (replace) {
    const same =
      file.testGlobsReplace === true &&
      file.testGlobs?.length === requested.length &&
      requested.every((g, i) => file.testGlobs?.[i] === g);
    if (same) {
      return block({ test_globs: "unchanged (no-op)", effective_test_globs: requested.length });
    }
    writeSettingsFile(root, { ...file, testGlobs: requested, testGlobsReplace: true });
    return out(
      block({ test_globs: "replaced", added: requested, effective_test_globs: requested.length }),
      helpBlock([AFTER_WRITE]),
    );
  }

  // A glob already in effect (in the file, or an active default) changes nothing.
  const existing = file.testGlobs ?? [];
  const defaultsActive = file.testGlobsReplace !== true;
  const added = requested.filter(
    (g) => !existing.includes(g) && !(defaultsActive && DEFAULT_TEST_GLOBS.includes(g)),
  );
  if (added.length === 0) {
    return block({
      test_globs: "unchanged (no-op)",
      effective_test_globs: loadSettings(process.cwd()).testGlobs.length,
    });
  }
  writeSettingsFile(root, { ...file, testGlobs: [...existing, ...added] });
  return out(
    block({
      test_globs: "updated",
      added,
      effective_test_globs: loadSettings(process.cwd()).testGlobs.length,
    }),
    helpBlock([AFTER_WRITE]),
  );
}

function normalizeProject(root: string, raw: string): string {
  const abs = resolve(root, raw);
  const rel = relative(root, abs).split(sep).join("/");
  if (rel === "" || rel.startsWith("..")) {
    throw usageError(`project '${raw}' must be a file inside ${root}`);
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw usageError(`project file not found: ${rel} (relative to ${root})`, [
      "usage: ts-axi config set project <tsconfig-path>",
    ]);
  }
  return rel;
}

function unsetCommand(args: string[]): string {
  const parsed = parseArgs(args, [], "ts-axi config unset");
  const [rawKey, extra] = parsed.positionals;
  if (extra !== undefined) {
    throw usageError(`unexpected argument '${extra}'`, ["usage: ts-axi config unset <key>"]);
  }
  const key = parseKey(rawKey, "ts-axi config unset");
  const root = findRoot(process.cwd());
  const file = readSettingsFile(root);
  const label = key === "project" ? "project" : "test_globs";

  const next: SettingsFile = { ...(file ?? {}) };
  if (key === "project") delete next.project;
  else {
    delete next.testGlobs;
    delete next.testGlobsReplace;
  }
  const hadIt = key === "project" ? file?.project !== undefined : file?.testGlobs !== undefined || file?.testGlobsReplace !== undefined;
  if (!hadIt) return block({ [label]: "not set (no-op)" });

  writeSettingsFile(root, next);
  return out(block({ [label]: "unset", file: fileLabel(true) }), helpBlock([AFTER_WRITE]));
}
