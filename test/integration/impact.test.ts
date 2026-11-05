import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeToon, prepareSample, type Sample } from "./helpers.js";

type Payload = Record<string, unknown>;
type Row = Record<string, unknown>;

let sample: Sample;

beforeAll(async () => {
  sample = await prepareSample();
});

afterEach(async () => {
  await sample.git("checkout", "-q", ".");
  await sample.git("clean", "-fdq");
});

afterAll(() => sample?.cleanup());

function edit(rel: string, from: string, to: string): void {
  const text = readFileSync(join(sample.dir, rel), "utf8");
  expect(text).toContain(from);
  sample.write(rel, text.replace(from, to));
}

// These tests check every changed[n] column, so they ask for all of them.
async function impact(...argv: string[]): Promise<Payload> {
  const { stdout, exitCode } = await sample.run("impact", ...argv, ...(argv.includes("--fields") ? [] : ["--fields", "all"]));
  expect(exitCode).toBe(0);
  return decodeToon(stdout);
}

const changed = (data: Payload) => data["changed"] as Row[];
const refFiles = (data: Payload, symbol: string) =>
  new Set((data["refs"] as Row[]).filter((r) => r["symbol"] === symbol).map((r) => r["file"]));
const spotsAt = (data: Payload) => (Array.isArray(data["blind_spots"]) ? (data["blind_spots"] as Row[]) : []).map((s) => `${s["file"]}:${s["line"]}`);

describe("impact on the Astro sample", () => {
  it("a Cart.total body edit is body with refs in CartSummary.tsx and two Test files", async () => {
    edit("src/lib/cart.ts", "return formatPrice(cents);", "return formatPrice(Math.round(cents));");
    const data = await impact();
    expect(changed(data)[0]).toMatchObject({ symbol: "Cart.total", kind: "method", change: "body", exported: true });
    expect(changed(data)[0]!["tests"]).toBeGreaterThanOrEqual(2);
    expect(refFiles(data, "Cart.total")).toContain("src/components/CartSummary.tsx");
    expect(spotsAt(data)).toContain("src/components/CartSummary.tsx:16");
    expect(data["elapsed_ms"]).toEqual(expect.any(Number));
  });

  it("a formatPrice signature change comes first, reaches analytics.js and has no blind spots", async () => {
    edit("src/lib/format.ts", "formatPrice(cents: number, currency = 'USD')", "formatPrice(cents: number, currency = 'USD', locale?: string)");
    const data = await impact();
    expect(changed(data)[0]).toMatchObject({ symbol: "formatPrice", change: "signature", exported: true });
    expect(refFiles(data, "formatPrice")).toContain("src/lib/analytics.js");
    expect(data["blind_spots"]).toBe(0);
  });

  it("a Cart.remove parameter type change lists the as-any access as a blind spot", async () => {
    edit("src/lib/cart.ts", "remove(id: string): void", "remove(id: string | number): void");
    const data = await impact();
    expect(changed(data)[0]).toMatchObject({ symbol: "Cart.remove", change: "signature" });
    expect(data["blind_spots"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ file: "src/components/CartSummary.tsx", line: 14, reason: "property access on any" })]),
    );
  });

  it("a change inside index.astro only is reported as skipped, not analysed", async () => {
    edit("src/pages/index.astro", "Menu as of", "Menu updated");
    const data = await impact();
    expect(data).toMatchObject({ changes: 0, skipped: [{ file: "src/pages/index.astro", reason: "not TS or JS source" }] });
  });

  it("--grep finds the .astro use of a changed function the checker cannot see", async () => {
    edit("src/lib/format.ts", "return `${d.getFullYear()}", "return `${d.getUTCFullYear()}");
    const data = await impact("--grep");
    const astro = readFileSync(join(sample.dir, "src/pages/index.astro"), "utf8").split("\n");
    const uses = astro.flatMap((line, i) => (/\bformatDate\b/.test(line) ? [`src/pages/index.astro:${i + 1}`] : []));
    expect(uses.length).toBeGreaterThanOrEqual(2);
    expect((data["unresolved"] as Row[]).map((r) => `${r["file"]}:${r["line"]}`)).toEqual(expect.arrayContaining(uses));
  });

  it("main...HEAD on a committed branch matches the working tree analysis", async () => {
    await sample.git("checkout", "-q", "-b", "feature");
    edit("src/lib/cart.ts", "return formatPrice(cents);", "return formatPrice(Math.round(cents));");
    await sample.git("commit", "-q", "-am", "round");
    try {
      const data = await impact("main...HEAD");
      expect(data).toMatchObject({ head: "HEAD", changes: 1 });
      expect(changed(data)[0]).toMatchObject({ symbol: "Cart.total", change: "body" });
    } finally {
      await sample.git("checkout", "-q", "main");
    }
  });
});
