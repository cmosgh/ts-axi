// Output size guard: every stdout byte costs an agent tokens. Each case's estimate is pinned in
// token-budget.json (fails when it grows past TOLERANCE) and held under a hard cap per output kind.
// Refresh the baseline after an intended change: TOKEN_BUDGET_UPDATE=1 corepack pnpm exec vitest run test/token-budget.test.ts
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { committed, LEGACY_FIXTURE, runIn } from "./helpers.js";
import { estimateTokens } from "./tokens.js";

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), "token-budget.json");
const TOLERANCE = 0.1;
const UPDATE = process.env["TOKEN_BUDGET_UPDATE"] === "1";

/** Drop what varies per run: timings and commit SHAs. */
function normalize(stdout: string): string {
  return stdout
    .replace(/^elapsed_ms: \d+\n/gm, "")
    .replace(/"elapsed_ms": \d+,?\n/g, "")
    .replace(/\b[0-9a-f]{40}\b/g, "<sha>");
}

type Kind = "home" | "query" | "report" | "error";
/** Hard ceilings per output kind, independent of the baseline. */
const CAPS: Record<Kind, number> = { home: 300, query: 300, report: 450, error: 100 };

interface Case {
  name: string;
  kind: Kind;
  fixture: "project" | "legacy";
  argv: string[];
}

const CASES: Case[] = [
  { name: "home", kind: "home", fixture: "project", argv: [] },
  { name: "def member", kind: "query", fixture: "project", argv: ["def", "User.save"] },
  { name: "def no match", kind: "query", fixture: "project", argv: ["def", "noSuchName"] },
  { name: "refs", kind: "query", fixture: "project", argv: ["refs", "runSync"] },
  { name: "callers", kind: "query", fixture: "project", argv: ["callers", "runSync"] },
  { name: "outline", kind: "query", fixture: "project", argv: ["outline", "src/models/user.ts"] },
  { name: "refs legacy directive", kind: "query", fixture: "legacy", argv: ["refs", "fancyBox"] },
  { name: "impact", kind: "report", fixture: "project", argv: ["impact"] },
  { name: "impact --fields all", kind: "report", fixture: "project", argv: ["impact", "--fields", "all"] },
  { name: "impact --size", kind: "report", fixture: "project", argv: ["impact", "--size"] },
  { name: "anchor", kind: "query", fixture: "project", argv: ["anchor", "src/models/user.ts:13", "src/models/user.ts:2"] },
  { name: "error unknown flag", kind: "error", fixture: "project", argv: ["refs", "runSync", "--bogus"] },
  { name: "error missing file", kind: "error", fixture: "project", argv: ["outline", "src/nope.ts"] },
];

const dirs: Record<Case["fixture"], string> = { project: "", legacy: "" };
const measured: Record<string, number> = {};
const baseline: Record<string, number> = UPDATE ? {} : (JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>);

beforeAll(() => {
  dirs.project = committed(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "project"));
  dirs.legacy = committed(LEGACY_FIXTURE);
  // One signature change, so impact and anchor have a diff to report.
  const user = join(dirs.project, "src/models/user.ts");
  writeFileSync(user, readFileSync(user, "utf8").replace("save(): boolean {", "save(force = false): boolean {"));
});

afterAll(() => {
  if (UPDATE) writeFileSync(BASELINE, `${JSON.stringify(measured, null, 2)}\n`);
});

describe("token budget", () => {
  for (const c of CASES) {
    it(`${c.name}: within its cap and baseline`, async () => {
      const { stdout } = await runIn(dirs[c.fixture], ...c.argv);
      const tokens = estimateTokens(normalize(stdout));
      measured[c.name] = tokens;
      expect(tokens, `${c.name} = ${tokens} tokens, cap ${CAPS[c.kind]}`).toBeLessThanOrEqual(CAPS[c.kind]);
      if (UPDATE) return;
      const pinned = baseline[c.name];
      expect(pinned, `no baseline for '${c.name}' - run with TOKEN_BUDGET_UPDATE=1`).toBeDefined();
      expect(tokens, `${c.name} grew from ${pinned} to ${tokens} tokens (> ${TOLERANCE * 100}%) - trim it or refresh the baseline`).toBeLessThanOrEqual(
        Math.floor(pinned! * (1 + TOLERANCE)),
      );
    }, 30_000);
  }
});
