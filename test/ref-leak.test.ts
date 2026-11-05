// The guard for `--ref`: while a run reads a git tree, nothing below the repo root may come from
// disk except node_modules, `.ts-axi.json` and the `.git` probe of settings. A new call site that
// bypasses `sourceFs()` fails here.
import { join, sep } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { committed, FIXTURE, LEGACY_FIXTURE, poison, runIn, WORKSPACE_FIXTURE } from "./helpers.js";

// Hoisted with vi.mock: the factory runs before the module body.
const spy = vi.hoisted(() => {
  const state = { recording: false, seen: [] as Array<{ fn: string; path: string }> };
  const record = (fn: string, arg: unknown): void => {
    if (!state.recording) return;
    const path = typeof arg === "string" ? arg : arg instanceof URL ? arg.pathname : Buffer.isBuffer(arg) ? arg.toString() : undefined;
    if (path !== undefined) state.seen.push({ fn, path });
  };
  const names = ["readFileSync", "existsSync", "statSync", "lstatSync", "readdirSync", "realpathSync", "openSync", "accessSync", "opendirSync"];
  return { state, record, names };
});
const { record } = spy;
const seen = spy.state.seen;

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const wrapped: Record<string, unknown> = { ...real };
  for (const name of spy.names) {
    const fn = (real as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
    wrapped[name] = (...args: unknown[]) => {
      spy.record(name, args[0]);
      return fn(...args);
    };
  }
  return { ...wrapped, default: wrapped };
});

const SYS = ["readFile", "fileExists", "directoryExists", "readDirectory", "getDirectories", "realpath", "getFileSize"] as const;
const originals = new Map<string, unknown>();

beforeAll(() => {
  const sys = ts.sys as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of SYS) {
    const fn = sys[name];
    if (typeof fn !== "function") continue;
    originals.set(name, fn);
    sys[name] = (...args: unknown[]) => {
      record(`ts.sys.${name}`, args[0]);
      return fn.apply(ts.sys, args);
    };
  }
});

afterAll(() => {
  const sys = ts.sys as unknown as Record<string, unknown>;
  for (const [name, fn] of originals) sys[name] = fn;
});

/** Disk accesses below `root` that a `--ref` run must not make. */
function leaks(root: string): string[] {
  return seen
    .filter(({ path }) => path === root || path.startsWith(root + sep))
    .filter(({ path }) => {
      const segments = path.slice(root.length).split(sep);
      const last = segments[segments.length - 1];
      return !segments.includes("node_modules") && last !== ".ts-axi.json" && last !== ".git";
    })
    .map(({ fn, path }) => `${fn} ${path}`);
}

const QUERIES = [
  ["outline", "src/models/user.ts"],
  ["outline", "src/**/*.ts"],
  ["def", "User"],
  ["def", "nothingLikeThis"],
  ["def", "src/services/sync.ts:16"],
  ["refs", "User.save", "--grep", "--via", "--implementations"],
  ["refs", "runSync", "-P", "tsconfig.json"],
  ["refs", "poisonedDecl", "-P", "tsconfig.json"],
  ["callers", "runSync", "--depth", "3"],
];

describe("--ref reads nothing below the repo root from disk", () => {
  it("plain TS project", async () => {
    const dir = committed(FIXTURE);
    poison(dir, ["User", "runSync"], { remove: "src/services/dates.ts", tsconfig: "tsconfig.json", tsconfigText: "{}" });
    for (const q of QUERIES) {
      seen.length = 0;
      spy.state.recording = true;
      const { exitCode, stdout } = await runIn(dir, ...q, "--ref", "HEAD");
      spy.state.recording = false;
      expect(exitCode, `${q.join(" ")}\n${stdout}`).toBe(0);
      expect(leaks(dir), q.join(" ")).toEqual([]);
    }
  });

  it("nx workspace from a project directory", async () => {
    const dir = committed(WORKSPACE_FIXTURE);
    poison(dir, ["formatMoney"], { remove: "services/reports/src/summary.ts", tsconfig: "tsconfig.base.json", tsconfigText: "{}" });
    const cwd = join(dir, "services/billing");
    for (const q of [["refs", "formatMoney"], ["callers", "roundCents", "--depth", "2"], ["def", "formatMoney"], ["refs", "formatMoney", "-P", "../../libs/shared/tsconfig.lib.json"]]) {
      seen.length = 0;
      spy.state.recording = true;
      const { exitCode, stdout } = await runIn(cwd, ...q, "--ref", "HEAD");
      spy.state.recording = false;
      expect(exitCode, `${q.join(" ")}\n${stdout}`).toBe(0);
      expect(leaks(dir), q.join(" ")).toEqual([]);
    }
  });

  it("legacy JavaScript, implicit project", async () => {
    const dir = committed(LEGACY_FIXTURE);
    poison(dir, ["round"], { remove: "lib/padding.js", tsconfig: "tsconfig.json", tsconfigText: "{}" });
    for (const q of [["refs", "round", "--grep"], ["callers", "net"], ["def", "round"]]) {
      seen.length = 0;
      spy.state.recording = true;
      const { exitCode, stdout } = await runIn(dir, ...q, "--ref", "HEAD");
      spy.state.recording = false;
      expect(exitCode, `${q.join(" ")}\n${stdout}`).toBe(0);
      expect(leaks(dir), q.join(" ")).toEqual([]);
    }
  });

  it("the spies catch a disk run (control)", async () => {
    const dir = committed(FIXTURE);
    seen.length = 0;
    spy.state.recording = true;
    await runIn(dir, "refs", "User.save");
    spy.state.recording = false;
    expect(leaks(dir).length).toBeGreaterThan(0);
  });
});
