// Task-based token cost: each task done with ts-axi and with a careful grep-and-read workflow
// (test/compare.ts). Gates: ts-axi lists every grep hit that is a real use, and costs <= MAX_RATIO.
// Ratios are pinned in token-compare.json (+TOLERANCE); TOKEN_BUDGET_UPDATE=1 refreshes them and the README table.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareTask, recallLabel, recallOf, reportTable, speedTable, TURN_MS, type Task, type TaskResult } from "../compare.js";
import { LEGACY_FIXTURE } from "../helpers.js";
import { CLI, prepareFixture, prepareSample, type Sample } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "token-compare.json");
const README = join(HERE, "..", "..", "README.md");
const REPORT = process.env["TOKEN_COMPARE_OUT"] ?? join(tmpdir(), "ts-axi-token-compare.md");
const UPDATE = process.env["TOKEN_BUDGET_UPDATE"] === "1";
const TOLERANCE = 0.1;
const MAX_RATIO = 0.3;

type Repo = "astro sample" | "legacy-js";

interface Case extends Task {
  repo: Repo;
  /** Why this task honestly costs more than MAX_RATIO: then only its pinned ratio is checked. */
  overRatio?: string;
  /** Applied to the working tree before the task, reverted after. */
  edit?: { file: string; from: string; to: string };
}

// The fixture files are 5-40 lines, so a ±40-line read is the whole file: the grep side is as cheap
// as it gets here. Real files are longer (see scripts/token-compare.ts).
const SMALL_FILE = "the class file has 36 lines, so the grep side reads all of it once";
const DUPLICATE_HINT = "the followed hint repeats the first output with the extra rows";

const CASES: Case[] = [
  { repo: "astro sample", name: "def of a class method", kind: "def", symbol: "Cart.total", overRatio: SMALL_FILE },
  { repo: "astro sample", name: "callers of a function", kind: "callers", symbol: "formatPrice" },
  { repo: "astro sample", name: "refs of a class member", kind: "refs", symbol: "Cart.total" },
  {
    repo: "astro sample",
    name: "impact of a signature change",
    kind: "impact",
    symbol: "formatPrice",
    edit: {
      file: "src/lib/format.ts",
      from: "formatPrice(cents: number, currency = 'USD')",
      to: "formatPrice(cents: number, currency = 'USD', locale?: string)",
    },
    overRatio: `${DUPLICATE_HINT} (refs on the changed function); impact alone is 0.33`,
  },
  {
    repo: "legacy-js",
    name: "template uses of a directive",
    kind: "refs",
    symbol: "fancyBox",
    templates: true,
    overRatio: `${DUPLICATE_HINT} (--grep); the two matching files have 21 and 4 lines`,
  },
  {
    repo: "legacy-js",
    name: "refs of an untyped CommonJS member",
    kind: "refs",
    symbol: "canReadItem",
    overRatio: `${DUPLICATE_HINT} (--grep); the two matching files have 24 and 12 lines`,
  },
];

const repos = {} as Record<Repo, Sample>;
const results = new Map<string, { repo: Repo; result: TaskResult }>();
const baseline: Record<string, number> = UPDATE ? {} : (JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>);

beforeAll(async () => {
  repos["astro sample"] = await prepareSample();
  repos["legacy-js"] = await prepareFixture(LEGACY_FIXTURE);
});

afterAll(() => {
  for (const repo of Object.values(repos)) repo?.cleanup();
  const rows = CASES.flatMap((c) => results.get(c.name) ?? []);
  if (!rows.length) return;
  const over = CASES.filter((c) => c.overRatio && results.has(c.name));
  const notes = over.map((c) => `- ${c.name} is over ${MAX_RATIO} - ${c.overRatio}.`).join("\n");
  const commands = rows
    .map(({ result: r }) => `${r.task.name}\n  ts-axi: ${r.axiCommands.join(" ; ")}\n  grep:   ${r.grepCommands.join(" ; ")}`)
    .join("\n");
  const speed = `${speedTable(rows)}\nEstimated task time = command time + ${TURN_MS / 1000} s per tool call (an assumed model round-trip).\n`;
  writeFileSync(REPORT, `${reportTable(rows)}\n${notes}\n\n${speed}\n${commands}\n`);
  process.stdout.write(`\n${reportTable(rows)}\n${notes}\n\n${speed}\n${commands}\n(written to ${REPORT})\n`);
  if (!UPDATE || rows.length !== CASES.length) return;
  writeFileSync(BASELINE, `${JSON.stringify(Object.fromEntries(rows.map((r) => [r.result.task.name, r.result.ratio])), null, 2)}\n`);
  // The README table is this report, never edited by hand.
  const readme = readFileSync(README, "utf8");
  const block = /(<!-- token-compare:start -->\n)[\s\S]*?(<!-- token-compare:end -->)/;
  expect(readme).toMatch(block);
  writeFileSync(README, readme.replace(block, (_, start: string, end: string) => `${start}${reportTable(rows)}\n${notes}\n${end}`));
});

async function run(c: Case): Promise<TaskResult> {
  const repo = repos[c.repo];
  if (!c.edit) return compareTask(CLI, repo.dir, c);
  const file = join(repo.dir, c.edit.file);
  const text = readFileSync(file, "utf8");
  expect(text).toContain(c.edit.from);
  writeFileSync(file, text.replace(c.edit.from, c.edit.to));
  try {
    return await compareTask(CLI, repo.dir, c);
  } finally {
    await repo.git("checkout", "-q", ".");
  }
}

describe("token cost against grep and read", () => {
  for (const c of CASES) {
    it(`${c.name} (${c.repo})`, async () => {
      const result = await run(c);
      results.set(c.name, { repo: c.repo, result });
      const { recall, ratio } = result;
      expect(recall.hits, "the grep workflow found nothing to compare").toBeGreaterThan(0);
      expect(recall.missing, `ts-axi misses grep hits (${recallLabel(recall)})`).toEqual([]);
      if (!c.overRatio) expect(ratio, `${result.axiTokens} vs ${result.grepTokens} tokens`).toBeLessThanOrEqual(MAX_RATIO);
      // Times are too noisy to gate; tool calls are exact.
      expect(result.axiCommands.length, result.grepCommands.join(" ; ")).toBeLessThanOrEqual(result.grepCommands.length);
      if (UPDATE) return;
      const pinned = baseline[c.name];
      expect(pinned, `no baseline for '${c.name}' - run with TOKEN_BUDGET_UPDATE=1`).toBeDefined();
      expect(ratio, `ratio grew from ${pinned} to ${ratio} (> ${TOLERANCE * 100}%)`).toBeLessThanOrEqual(pinned! * (1 + TOLERANCE));
    });
  }

  it("the recall gate lists a location that ts-axi output leaves out", async () => {
    const result = results.get("callers of a function")?.result ?? (await run(CASES[1]!));
    const dropped = result.axiOutputs.map((o) => o.replace(/^ {2}src\/lib\/analytics\.js,4,.*\n/m, "").replace(/refs\[7\]/, "refs[6]"));
    expect(dropped).not.toEqual(result.axiOutputs);
    expect(recallOf(dropped, result.hits, result.task).missing).toEqual([
      "src/lib/analytics.js:4: return { event: 'purchase', value: formatPrice(cents, 'EUR') };",
    ]);
  });
});
