import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeToon, prepareSample, type Sample } from "./helpers.js";

type Payload = Record<string, unknown>;
type Row = Record<string, unknown>;

let sample: Sample;

beforeAll(async () => {
  sample = await prepareSample();
});

afterAll(() => sample?.cleanup());

async function toon(...argv: string[]): Promise<Payload> {
  const { stdout, exitCode } = await sample.run(...argv);
  expect(exitCode).toBe(0);
  return decodeToon(stdout);
}

const rowsOf = (data: Payload, key: string) => data[key] as Row[];
const locations = (rows: Row[]) => rows.map((r) => `${r["file"]}:${r["line"]}`);

describe("home view", () => {
  it("reports the sample project, test globs and test files", async () => {
    const data = await toon();
    expect(data).toMatchObject({
      tsconfig: "tsconfig.json",
      test_globs: 10,
      test_files: 4,
      settings: ".ts-axi.json (present)",
      git: "main (0 dirty)",
    });
    expect(data["source_files"]).toBeGreaterThanOrEqual(10);
  });
});

describe("config", () => {
  it("shows the .it.ts glob with its source", async () => {
    const data = await toon("config");
    const globs = rowsOf(data, "test_globs");
    expect(globs).toHaveLength(10);
    expect(globs.find((g) => g["glob"] === "**/*.it.ts")).toMatchObject({ source: ".ts-axi.json" });
    expect(globs.filter((g) => g["source"] === "default")).toHaveLength(9);
  });

  it("set test-globs round-trips through .ts-axi.json and a repeat is a no-op", async () => {
    const before = readFileSync(join(sample.dir, ".ts-axi.json"), "utf8");
    try {
      const added = await toon("config", "set", "test-globs", "**/*.e2e.ts");
      expect(added).toMatchObject({ test_globs: "updated", added: ["**/*.e2e.ts"], effective_test_globs: 11 });
      expect(JSON.parse(readFileSync(join(sample.dir, ".ts-axi.json"), "utf8"))).toEqual({
        testGlobs: ["**/*.it.ts", "**/*.e2e.ts"],
      });

      const globs = rowsOf(await toon("config"), "test_globs");
      expect(globs.find((g) => g["glob"] === "**/*.e2e.ts")).toMatchObject({ source: ".ts-axi.json" });

      const again = await toon("config", "set", "test-globs", "**/*.e2e.ts");
      expect(again).toMatchObject({ test_globs: "unchanged (no-op)", effective_test_globs: 11 });
    } finally {
      sample.write(".ts-axi.json", before);
    }
    expect(rowsOf(await toon("config"), "test_globs")).toHaveLength(10);
  });
});

describe("outline", () => {
  it("lists the 8 Declarations of src/lib/cart.ts with kinds and lines", async () => {
    const data = await toon("outline", "src/lib/cart.ts", "--fields", "exported");
    expect(data["file"]).toBe("src/lib/cart.ts");
    const decls = rowsOf(data, "decls");
    expect(decls.map((d) => [d["line"], d["kind"], d["name"], d["exported"]])).toEqual([
      [3, "interface", "CartItem", true],
      [10, "type", "CartEvent", true],
      [12, "class", "Cart", true],
      [13, "property", "Cart.items", false],
      [15, "method", "Cart.empty", true],
      [19, "method", "Cart.add", true],
      [28, "method", "Cart.remove", true],
      [32, "method", "Cart.total", true],
    ]);
    expect(decls.find((d) => d["name"] === "Cart.total")?.["signature"]).toBe("total(): string");
  });
});

describe("def", () => {
  it("lists both parse functions and how to disambiguate them", async () => {
    const { stdout, exitCode } = await sample.run("def", "parse");
    expect(exitCode).toBe(0);
    const data = decodeToon(stdout);
    expect(data["symbol"]).toBe("parse");
    const matches = rowsOf(data, "matches");
    expect(matches.map((m) => [m["at"], m["kind"], String(m["signature"]).startsWith("export ")])).toEqual([
      ["src/lib/parse.ts:1", "function", true],
      ["src/lib/query.ts:1", "function", true],
    ]);
    expect(stdout).toContain("ts-axi def src/lib/parse.ts:1");
    expect(stdout).toContain("ts-axi def src/lib/query.ts:1");
    expect(stdout).toContain("--in src/lib/parse.ts");
  });

  it("resolves a path:line position to one Declaration with its body", async () => {
    const { stdout } = await sample.run("def", "src/lib/query.ts:1");
    expect(decodeToon(stdout)).toMatchObject({ file: "src/lib/query.ts", line: 1, kind: "function", exported: true });
    expect(stdout).toContain("   1 | export function parse(q: string): Record<string, string> {");
    expect(stdout).not.toContain("parse.ts");
  });

  it("finds Cart.total at line 32 with absolute line numbers in the fence", async () => {
    const { stdout } = await sample.run("def", "Cart.total");
    expect(decodeToon(stdout)).toMatchObject({
      file: "src/lib/cart.ts",
      line: 32,
      kind: "method",
      exported: true,
      signature: "total(): string",
    });
    const fenced = stdout.split("\n---\n")[1]!;
    expect(fenced.split("\n")[0]).toBe("  32 |   total(): string {");
    expect(fenced).toContain("  34 |     return formatPrice(cents);");
    expect(fenced).toContain("  35 |   }");
  });

  it("reports the unexported helper pad2 as not exported", async () => {
    const data = await toon("def", "pad2");
    expect(data).toMatchObject({ file: "src/lib/format.ts", line: 1, exported: false });
  });

  it("answers an unknown name with matches: 0", async () => {
    const data = await toon("def", "nothing");
    expect(data["matches"]).toBe(0);
  });

  it("offers did_you_mean for a near miss", async () => {
    const data = await toon("def", "formatPrise");
    expect(data).toMatchObject({ matches: 0, did_you_mean: ["formatPrice"] });
  });
});

describe("refs", () => {
  it("finds every real reference of formatPrice across ts, tsx and js", async () => {
    const data = await toon("refs", "formatPrice");
    expect(data).toMatchObject({
      symbol: "formatPrice",
      kind: "function",
      declared_at: "src/lib/format.ts:5",
      refs_total: 13,
      files: 6,
      // Test files that reference it: format.test.ts and cart.it.ts.
      tests: 2,
    });
    const refs = rowsOf(data, "refs");
    expect(locations(refs)).toEqual([
      "src/components/Counter.tsx:2",
      "src/components/Counter.tsx:12",
      "src/components/ProductCard.tsx:1",
      "src/components/ProductCard.tsx:13",
      "src/lib/analytics.js:1",
      "src/lib/analytics.js:4",
      "src/lib/cart.it.ts:2",
      "src/lib/cart.it.ts:8",
      "src/lib/cart.ts:1",
      "src/lib/cart.ts:34",
      "src/lib/format.test.ts:2",
      "src/lib/format.test.ts:6",
      "src/lib/format.test.ts:9",
    ]);
    expect(refs.some((r) => String(r["file"]).endsWith("index.astro"))).toBe(false);
    expect(refs.some((r) => r["file"] === "src/lib/format.ts")).toBe(false);
  });

  it("does not analyse .astro files: refs formatDate has no index.astro row", async () => {
    const { stdout } = await sample.run("refs", "formatDate");
    const data = decodeToon(stdout);
    expect(data).toMatchObject({ symbol: "formatDate", declared_at: "src/lib/format.ts:11", refs_total: 0, files: 0 });
    expect(stdout).not.toContain("index.astro");
  });
});

describe("callers", () => {
  it("lists the 8 callers of Cart.total with their enclosing function", async () => {
    const data = await toon("callers", "Cart.total");
    expect(data).toMatchObject({ symbol: "Cart.total", declared_at: "src/lib/cart.ts:32", refs_total: 8, files: 5, tests: 3 });
    const rows = rowsOf(data, "refs");
    expect(rows.map((r) => `${r["file"]}:${r["line"]}:${r["caller"]}`)).toEqual([
      "src/components/CartSummary.tsx:6:CartSummary",
      "src/components/CartSummary.tsx:10:addBeans",
      "src/hooks/useCart.test.ts:9:(top-level)",
      "src/hooks/useCart.test.ts:15:(top-level)",
      "src/hooks/useCart.ts:35:useCart",
      "src/lib/cart.it.ts:8:(top-level)",
      "src/lib/cart.spec.ts:8:(top-level)",
      "src/lib/cart.spec.ts:14:(top-level)",
    ]);
  });

  it("--depth 2 adds counts of who calls the callers", async () => {
    const data = await toon("callers", "formatPrice", "--depth", "2");
    expect(rowsOf(data, "refs")).toHaveLength(7);
    const level2 = rowsOf(data, "callers_depth2");
    expect(level2.map((r) => `${r["file"]}:${r["caller"]}:${r["count"]}`)).toEqual([
      "src/hooks/useCart.test.ts:(top-level):2",
      "src/lib/cart.spec.ts:(top-level):2",
      "src/components/CartSummary.tsx:CartSummary:1",
      "src/components/CartSummary.tsx:addBeans:1",
      "src/components/ProductList.tsx:ProductList:1",
      "src/hooks/useCart.ts:useCart:1",
      "src/lib/cart.it.ts:(top-level):1",
    ]);
  });

  it("--depth 2 reports callers_depth2: 0 when nothing calls the callers", async () => {
    const data = await toon("callers", "useCart", "--depth", "2");
    expect(rowsOf(data, "refs")).toHaveLength(2);
    expect(data["callers_depth2"]).toBe(0);
  });
});

describe("components and hooks", () => {
  it("outlines ProductCard.tsx: an exported interface and function component", async () => {
    const data = await toon("outline", "src/components/ProductCard.tsx", "--fields", "exported");
    const decls = rowsOf(data, "decls");
    expect(decls.map((d) => [d["line"], d["kind"], d["name"], d["exported"]])).toEqual([
      [3, "interface", "ProductCardProps", true],
      [8, "function", "ProductCard", true],
    ]);
    expect(decls[1]?.["signature"]).toBe("export function ProductCard(props: ProductCardProps)");
  });

  it("marks the unexported prop type alias of CartBadge as not exported", async () => {
    const decls = rowsOf(await toon("outline", "src/components/CartBadge.tsx", "--fields", "exported"), "decls");
    expect(decls.map((d) => [d["line"], d["kind"], d["name"], d["exported"]])).toEqual([
      [4, "type", "CartBadgeProps", false],
      [6, "function", "CartBadge", true],
    ]);
  });

  it("def ProductCardProps is an exported interface", async () => {
    const data = await toon("def", "ProductCardProps");
    expect(data).toMatchObject({ file: "src/components/ProductCard.tsx", line: 3, kind: "interface", exported: true });
  });

  it("def ProductList treats the default export as exported", async () => {
    const data = await toon("def", "ProductList");
    expect(data).toMatchObject({ file: "src/components/ProductList.tsx", line: 6, kind: "function", exported: true });
  });

  it("refs ProductCard includes the import and the JSX usage", async () => {
    const data = await toon("refs", "ProductCard");
    expect(data).toMatchObject({ symbol: "ProductCard", kind: "function", declared_at: "src/components/ProductCard.tsx:8", refs_total: 2, files: 1, tests: 0 });
    const refs = rowsOf(data, "refs");
    expect(locations(refs)).toEqual(["src/components/ProductList.tsx:4", "src/components/ProductList.tsx:20"]);
    expect(String(refs[0]?.["context"])).toContain("import { ProductCard }");
    expect(String(refs[1]?.["context"])).toContain("<ProductCard");
  });

  it("callers ProductCard counts the JSX usage as a call from ProductList", async () => {
    const rows = rowsOf(await toon("callers", "ProductCard"), "refs");
    expect(rows.map((r) => `${r["file"]}:${r["line"]}:${r["caller"]}`)).toEqual(["src/components/ProductList.tsx:20:ProductList"]);
  });

  it("callers useCart names the two components that call the hook", async () => {
    const data = await toon("callers", "useCart");
    expect(data).toMatchObject({ declared_at: "src/hooks/useCart.ts:23", refs_total: 2, files: 2, tests: 0 });
    expect(rowsOf(data, "refs").map((r) => `${r["file"]}:${r["line"]}:${r["caller"]}`)).toEqual([
      "src/components/CartBadge.tsx:7:CartBadge",
      "src/components/ProductList.tsx:7:ProductList",
    ]);
  });

  it("refs useLocalStorage spans a component and a hook, never the declaration", async () => {
    const data = await toon("refs", "useLocalStorage");
    expect(data).toMatchObject({ declared_at: "src/hooks/useLocalStorage.ts:13", refs_total: 4, files: 2, tests: 0 });
    const refs = rowsOf(data, "refs");
    expect(locations(refs)).toEqual([
      "src/components/CartBadge.tsx:2",
      "src/components/CartBadge.tsx:8",
      "src/hooks/useCart.ts:2",
      "src/hooks/useCart.ts:24",
    ]);
    expect(refs.some((r) => r["file"] === "src/hooks/useLocalStorage.ts")).toBe(false);
  });

  it("callers reduceCart counts the test file", async () => {
    const data = await toon("callers", "reduceCart");
    expect(data).toMatchObject({ declared_at: "src/hooks/useCart.ts:14", refs_total: 4, files: 2, tests: 1 });
    expect(rowsOf(data, "refs").map((r) => `${r["file"]}:${r["line"]}:${r["caller"]}`)).toEqual([
      "src/hooks/useCart.test.ts:9:(top-level)",
      "src/hooks/useCart.test.ts:13:(top-level)",
      "src/hooks/useCart.test.ts:14:(top-level)",
      "src/hooks/useCart.ts:25:useCart",
    ]);
  });

  it("refs CartAction finds the type in useCart.ts and the test", async () => {
    const data = await toon("refs", "CartAction");
    expect(data).toMatchObject({ kind: "type", declared_at: "src/hooks/useCart.ts:4", refs_total: 4, files: 2, tests: 1 });
    expect(locations(rowsOf(data, "refs"))).toEqual([
      "src/hooks/useCart.test.ts:3",
      "src/hooks/useCart.test.ts:12",
      "src/hooks/useCart.ts:14",
      "src/hooks/useCart.ts:27",
    ]);
  });

  it("def useLocalStorage fences the generic hook body with useState", async () => {
    const { stdout } = await sample.run("def", "useLocalStorage");
    expect(decodeToon(stdout)).toMatchObject({
      file: "src/hooks/useLocalStorage.ts",
      line: 13,
      kind: "function",
      exported: true,
      signature: "export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void]",
    });
    const fenced = stdout.split("\n---\n")[1]!;
    expect(fenced.split("\n")[0]).toBe("  13 | export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {");
    expect(fenced).toContain("  14 |   const [value, setValue] = useState<T>(() => readStored(key, initial));");
  });

  it("def readStored is an unexported helper", async () => {
    const data = await toon("def", "readStored");
    expect(data).toMatchObject({ file: "src/hooks/useLocalStorage.ts", line: 3, exported: false });
  });
});

describe("interface implementations (src/lib/parsers.ts)", () => {
  it("callers Discount.adjust: the direct call only, the interface call is via_interface", async () => {
    const data = await toon("callers", "Discount.adjust");
    expect(data).toMatchObject({ symbol: "Discount.adjust", declared_at: "src/lib/parsers.ts:6", refs_total: 1, via_interface: "1 (PriceRule.adjust)" });
    expect(rowsOf(data, "refs").map((r) => `${r["file"]}:${r["line"]}:${r["caller"]}`)).toEqual(["src/lib/parsers.ts:21:(top-level)"]);
  });

  it("refs Discount.adjust --via adds the PriceRule call; Surcharge never appears", async () => {
    const { stdout } = await sample.run("refs", "Discount.adjust", "--via");
    const data = decodeToon(stdout);
    expect(data["refs_total"]).toBe(1);
    expect(rowsOf(data, "refs").map((r) => `${r["line"]}:${r["via"]}`)).toEqual(["18:PriceRule.adjust", "21:-"]);
    expect(stdout).not.toContain("parsers.ts,12");
  });

  it("refs PriceRule.adjust counts the two implementations, not as refs", async () => {
    const data = await toon("refs", "PriceRule.adjust");
    expect(data).toMatchObject({ refs_total: 1, implementations: 2, via_implementations: "1 (Discount.adjust)" });
    expect(locations(rowsOf(data, "refs"))).toEqual(["src/lib/parsers.ts:18"]);
  });
});

describe("--json", () => {
  it("decodes to the same payload as the TOON output", async () => {
    const { stdout } = await sample.run("refs", "formatPrice");
    const asToon = decode(stdout, { strict: true }) as Payload;
    const asJson = await sample.runJson("refs", "formatPrice");
    // elapsed_ms differs between runs.
    const { elapsed_ms: a, ...toonRest } = asToon;
    const { elapsed_ms: b, ...jsonRest } = asJson;
    expect(typeof a).toBe("number");
    expect(typeof b).toBe("number");
    expect(jsonRest).toEqual(toonRest);
  });
});

describe("errors and timing", () => {
  it("rejects an unknown flag with exit 2 and the valid set", async () => {
    const { stdout, exitCode } = await sample.run("def", "parse", "--bogus");
    expect(exitCode).toBe(2);
    const data = decodeToon(stdout);
    expect(data["code"]).toBe("VALIDATION_ERROR");
    expect(stdout).toContain("--bogus");
    expect(stdout).toContain("--kind");
  });

  it("reports elapsed_ms under 5 seconds for semantic commands", async () => {
    for (const argv of [["refs", "formatPrice"], ["callers", "Cart.total"]]) {
      const data = await toon(...argv);
      expect(data["elapsed_ms"]).toBeTypeOf("number");
      expect(data["elapsed_ms"] as number).toBeLessThan(5000);
    }
  });
});

describe("--ref HEAD on a dirty working tree", () => {
  const QUERIES = [
    ["outline", "src/lib/cart.ts"],
    ["def", "Cart.total"],
    ["refs", "formatPrice"],
    ["callers", "Cart.total"],
  ];
  const strip = (data: Payload): Payload => {
    const { ref: _ref, node_modules: _nm, elapsed_ms: _ms, help: _help, ...rest } = data;
    return rest;
  };

  it("answers each command like the clean checkout", async () => {
    const clean: Payload[] = [];
    for (const q of QUERIES) clean.push(await toon(...q));
    const original = readFileSync(join(sample.dir, "src/lib/cart.ts"), "utf8");
    try {
      sample.write("src/lib/cart.ts", `// moved\n\n\n${original.replace("total(): string", "sum(): string")}`);
      sample.write("src/lib/format.ts", "export const broken = (;\n");
      for (const [i, q] of QUERIES.entries()) {
        const data = await toon(...q, "--ref", "HEAD");
        expect(data["ref"]).toMatch(/^HEAD @ [0-9a-f]{7}$/);
        expect(strip(data), q.join(" ")).toEqual(strip(clean[i]!));
      }
    } finally {
      await sample.git("checkout", "-q", ".");
    }
  });
});
