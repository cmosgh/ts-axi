import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { committed, COMMONJS_FIXTURE, FIXTURE, fixtureCopy, git, LEGACY_FIXTURE, poison, runIn, WORKSPACE_FIXTURE } from "./helpers.js";

/** Output with the `--ref` header, timings and the `--ref` hint suffix removed. */
function normalize(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => !/^(ref|node_modules): /.test(l))
    .join("\n")
    .replace(/elapsed_ms: \d+/g, "elapsed_ms: X")
    .replace(/ --ref HEAD/g, "");
}

interface Case {
  name: string;
  fixture: string;
  /** Subdirectory to run in (cwd mapping). */
  cwd?: string;
  queries: string[][];
  names: string[];
  remove: string;
  tsconfig: string;
  tsconfigText: string;
}

const CASES: Case[] = [
  {
    name: "plain TS with include",
    fixture: FIXTURE,
    queries: [
      ["outline", "src/models/user.ts"],
      ["def", "User"],
      ["def", "save"],
      ["def", "src/services/sync.ts:16"],
      ["refs", "User.save"],
      ["refs", "runSync", "--via"],
      ["callers", "runSync"],
      ["callers", "src/services/sync.ts:11", "--depth", "2"],
      ["outline", "src/**/*.ts"],
    ],
    names: ["User", "runSync", "save"],
    remove: "src/services/dates.ts",
    tsconfig: "tsconfig.json",
    tsconfigText: `{ "compilerOptions": { "strict": false }, "include": ["decoy.ts"], "exclude": ["src"] }`,
  },
  {
    name: "nx + pnpm workspace, run from a project directory",
    fixture: WORKSPACE_FIXTURE,
    cwd: "services/billing",
    queries: [
      ["def", "formatMoney"],
      ["refs", "formatMoney"],
      ["callers", "roundCents"],
      ["outline", "../../libs/shared/src/lib/money.ts"],
      ["refs", "../../libs/shared/src/lib/money.ts:6", "-P", "../../libs/shared/tsconfig.lib.json"],
    ],
    names: ["formatMoney", "roundCents"],
    remove: "services/reports/src/summary.ts",
    tsconfig: "libs/shared/tsconfig.lib.json",
    tsconfigText: `{ "include": ["nothing/**"] }`,
  },
  {
    name: "legacy JavaScript without a tsconfig",
    fixture: LEGACY_FIXTURE,
    queries: [
      ["outline", "lib/totals.js"],
      ["def", "round"],
      ["refs", "round"],
      ["callers", "net"],
    ],
    names: ["round", "net"],
    remove: "lib/padding.js",
    tsconfig: "tsconfig.json",
    tsconfigText: `{ "compilerOptions": { "allowJs": true }, "include": ["lib/decoy.js"] }`,
  },
  {
    name: "CommonJS package without a tsconfig",
    fixture: COMMONJS_FIXTURE,
    queries: [
      ["outline", "lib/app.js"],
      ["def", "createApp"],
      ["refs", "createApp"],
      ["callers", "createApp"],
    ],
    names: ["createApp"],
    remove: "examples/basic.js",
    tsconfig: "tsconfig.json",
    tsconfigText: `{ "compilerOptions": { "allowJs": true }, "include": ["decoy.ts"] }`,
  },
];

describe("--ref HEAD on a poisoned working tree", () => {
  for (const c of CASES) {
    it(`answers like a clean checkout - ${c.name}`, async () => {
      const dir = committed(c.fixture);
      const cwd = join(dir, c.cwd ?? "");
      const clean: string[] = [];
      for (const q of c.queries) clean.push((await runIn(cwd, ...q)).stdout);
      poison(dir, c.names, c);
      const dirty: string[] = [];
      for (const q of c.queries) {
        const { stdout, exitCode } = await runIn(cwd, ...q, "--ref", "HEAD");
        expect(exitCode, `${q.join(" ")}\n${stdout}`).toBe(0);
        expect(stdout.split("\n")[0]).toMatch(/^ref: HEAD @ [0-9a-f]{7}$/);
        expect(normalize(stdout), q.join(" ")).toBe(normalize(clean[c.queries.indexOf(q)]!));
        dirty.push((await runIn(cwd, ...q)).stdout);
      }
      // The poison is real: without --ref most answers change.
      const changed = dirty.filter((d, i) => normalize(d) !== normalize(clean[i]!)).length;
      expect(changed).toBeGreaterThanOrEqual(Math.ceil(c.queries.length / 2));
    }, 30_000);
  }
});

describe("--ref CLI", () => {
  it("prints the header and keeps --ref in every follow-up hint", async () => {
    const dir = committed(FIXTURE);
    const { stdout } = await runIn(dir, "def", "save", "--ref", "HEAD");
    expect(stdout.split("\n")[0]).toMatch(/^ref: HEAD @ [0-9a-f]{7}$/);
    const hints = stdout.split("\n").filter((l) => l.startsWith("  - ") && /`ts-axi (def|refs|callers|outline)/.test(l));
    expect(hints.length).toBeGreaterThan(0);
    for (const hint of hints) expect(hint).toMatch(/ --ref HEAD`/);
    const callers = await runIn(dir, "callers", "runSync", "--ref", "HEAD");
    expect(callers.stdout).toContain("--ref HEAD`");
    expect(callers.stdout).not.toContain("--ref HEAD --ref");
  });

  it("puts ref in the --json payload", async () => {
    const dir = committed(FIXTURE);
    const { stdout } = await runIn(dir, "outline", "src/models/user.ts", "--ref", "HEAD", "--json");
    const data = JSON.parse(stdout) as Record<string, unknown>;
    expect(data["ref"]).toMatch(/^HEAD @ [0-9a-f]{7}$/);
    expect(data["file"]).toBe("src/models/user.ts");
  });

  it("answers at an older revision and reports files missing there", async () => {
    const dir = committed(FIXTURE);
    writeFileSync(join(dir, "src/added.ts"), "export function addedLater() {}\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add");
    expect((await runIn(dir, "def", "addedLater")).stdout).toContain("file: src/added.ts");
    expect(decode((await runIn(dir, "def", "addedLater", "--ref", "HEAD~1")).stdout.split("\nhelp")[0]!)).toMatchObject({ matches: 0 });
    const missing = await runIn(dir, "outline", "src/added.ts", "--ref", "HEAD~1");
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toContain("file not in HEAD~1: src/added.ts");
    const position = await runIn(dir, "refs", "src/added.ts:1", "--ref", "HEAD~1");
    expect(position.exitCode).toBe(2);
    expect(position.stdout).toContain("file not in HEAD~1");
  });

  it("rejects --ref on impact, config and setup with a hint", async () => {
    const dir = committed(FIXTURE);
    const impact = await runIn(dir, "impact", "--ref", "origin/main");
    expect(impact.exitCode).toBe(2);
    expect(impact.stdout).toContain("ts-axi impact origin/main...HEAD");
    for (const argv of [["config", "--ref", "HEAD"], ["setup", "hooks", "--ref", "HEAD"]]) {
      const result = await runIn(dir, ...argv);
      expect(result.exitCode, argv.join(" ")).toBe(2);
      expect(result.stdout).toContain("--ref works with def, refs, callers, outline only");
    }
  });

  it("fails clearly on a bad revision, a dash revision and outside git", async () => {
    const dir = committed(FIXTURE);
    const unknown = await runIn(dir, "def", "User", "--ref", "no-such-branch");
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stdout).toContain("code: GIT_ERROR");
    expect(unknown.stdout).toContain("unknown revision 'no-such-branch'");
    const dash = await runIn(dir, "def", "User", "--ref=--all");
    expect(dash.exitCode).toBe(2);
    expect(dash.stdout).toContain("invalid --ref '--all'");
    const plain = fixtureCopy();
    rmSync(join(plain, ".git"), { recursive: true, force: true });
    const outside = await runIn(plain, "def", "User", "--ref", "HEAD");
    expect(outside.exitCode).toBe(2);
    expect(outside.stdout).toContain("--ref needs a git repository");
  });

  it("does not leak the tree into the next run", async () => {
    const dir = committed(FIXTURE);
    writeFileSync(join(dir, "src/fresh.ts"), "export function freshOnDisk() {}\n");
    await runIn(dir, "def", "User", "--ref", "HEAD");
    const after = await runIn(dir, "def", "freshOnDisk");
    expect(after.stdout).toContain("file: src/fresh.ts");
    expect(after.stdout).not.toContain("ref:");
  });
});
