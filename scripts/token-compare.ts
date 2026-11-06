// Local only, never in CI: the token comparison of test/integration/token-compare.test.ts on any repo.
//   corepack pnpm run build && corepack pnpm exec tsx scripts/token-compare.ts <repo> <tasks.json>
// tasks.json: [{ "name", "kind": "def|callers|refs|impact", "symbol", "range"?, "templates"? }]
// Read-only on <repo>: ts-axi queries, git grep and git diff, file reads. Prints to stdout only.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { compareTask, recallLabel, reportTable, speedTable, targetsOf, TURN_MS, type Hit, type Task, type TaskResult } from "../test/compare.js";

const KINDS = new Set(["def", "callers", "refs", "impact"]);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin", "ts-axi.js");

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const [repoArg, tasksArg] = process.argv.slice(2);
if (!repoArg || !tasksArg) fail("usage: tsx scripts/token-compare.ts <repo> <tasks.json>");
const repo = resolve(repoArg);
if (!existsSync(join(repo, ".git"))) fail(`${repo} is not a git repository root`);
if (!existsSync(CLI)) fail(`${CLI} not found - run the build first`);

const tasks = JSON.parse(readFileSync(tasksArg, "utf8")) as Task[];
for (const t of tasks) {
  if (!t.name || !KINDS.has(t.kind) || !t.symbol) fail(`invalid task ${JSON.stringify(t)} - needs name, kind (def|callers|refs|impact), symbol`);
}

const results: TaskResult[] = [];
for (const task of tasks) results.push(await compareTask(CLI, repo, task));

const rows = results.map((result) => ({ repo: "target", result }));
process.stdout.write(reportTable(rows));
process.stdout.write(`\n${speedTable(rows)}\nEstimated task time = command time + ${TURN_MS / 1000} s per tool call (an assumed model round-trip).\n`);
for (const r of results) {
  process.stdout.write(`\n${r.task.name}: ${recallLabel(r.recall)}\n  ts-axi: ${r.axiCommands.join(" ; ")}\n  grep:   ${r.grepCommands.filter((c) => !c.startsWith("read ")).join(" ; ")} ; ${r.grepCommands.filter((c) => c.startsWith("read ")).length} reads\n`);
  if (!r.recall.missingHits.length) continue;
  // On a real repo a common name matches other declarations too: ask the checker what each unlisted hit is.
  const sorted = classify(repo, r.recall.missingHits, targetsOf(r.axiOutputs));
  const counts = Object.entries(sorted).map(([k, v]) => `${v.length} ${k}`);
  const real = r.recall.hits - sorted["other symbol"].length;
  const found = real - sorted["same symbol"].length - sorted.unresolved.length;
  process.stdout.write(`  unlisted hits: ${counts.join(", ")}\n  recall without other-symbol hits: ${Math.floor((found / real) * 100)}% (${found}/${real})\n`);
  for (const m of [...sorted["same symbol"], ...sorted["unresolved"]]) process.stdout.write(`  missing ${m}\n`);
}

type Verdict = "same symbol" | "other symbol" | "unresolved";

/** Resolve each hit's identifier with a program of its nearest tsconfig.json: does it name a target declaration? */
function classify(root: string, hits: Hit[], targets: Set<string>): Record<Verdict, string[]> {
  const out: Record<Verdict, string[]> = { "same symbol": [], "other symbol": [], unresolved: [] };
  const groups = new Map<string, Hit[]>();
  for (const h of hits) {
    const config = ts.findConfigFile(dirname(join(root, h.file)), ts.sys.fileExists) ?? "";
    groups.set(config, [...(groups.get(config) ?? []), h]);
  }
  for (const [config, group] of groups) {
    const parsed = config ? ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }) : undefined;
    const program = ts.createProgram(
      group.map((h) => join(root, h.file)),
      { ...(parsed?.options ?? { allowJs: true }), noEmit: true },
    );
    const checker = program.getTypeChecker();
    for (const h of group) {
      const label = `${h.file}:${h.line}: ${h.text.trim()}`;
      const source = program.getSourceFile(join(root, h.file));
      const m = new RegExp(h.needle.source).exec(h.text);
      if (!source || !m) {
        out.unresolved.push(label);
        continue;
      }
      const offset = m.index + (m[0].startsWith(".") ? 1 : 0);
      const pos = source.getPositionOfLineAndCharacter(h.line - 1, offset);
      let symbol = checker.getSymbolAtLocation(deepest(source, pos));
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const decls = symbol?.declarations ?? [];
      if (!decls.length) {
        out.unresolved.push(label);
        continue;
      }
      const at = decls.map((d) => {
        const node = ts.getNameOfDeclaration(d) ?? d;
        const file = node.getSourceFile();
        return `${relative(root, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      });
      out[at.some((a) => targets.has(a)) ? "same symbol" : "other symbol"].push(label);
    }
  }
  return out;
}

function deepest(node: ts.Node, pos: number): ts.Node {
  for (const child of node.getChildren()) if (child.getStart() <= pos && pos < child.getEnd()) return deepest(child, pos);
  return node;
}
