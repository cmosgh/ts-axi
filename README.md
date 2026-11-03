# ts-axi

Agent-ergonomic **TypeScript / JavaScript** code CLI, built on the [AXI](https://axi.md) principles: token-efficient [TOON](https://toonformat.dev/) output, minimal schemas, pre-computed aggregates, definitive empty states, structured errors and next-step hints.

It is **change-impact first**. When an agent reviews a diff, the expensive question is "what else does this touch?" - normally answered by grepping and reading dozens of files. `ts-axi impact` answers it from the compiler's own symbol resolution: for every declaration the diff changes, it lists the references *outside* the change set, grouped by file, with test coverage counted separately.

```
# real output: test/integration/sample on a branch that adds a `locale` parameter
# to formatPrice and edits the body of Cart.total
$ ts-axi impact main...HEAD
base: 923fb4d7ddc8f4e5c4df9029be388f8cb29ce095
head: HEAD
changes: 2
changed[2]{symbol,kind,change,exported,at,refs_total,refs_outside,via,files,tests}:
  formatPrice,function,signature,true,"src/lib/format.ts:5",13,12,0,6,2
  Cart.total,method,body,true,"src/lib/cart.ts:32",8,8,0,5,3
refs[20]{symbol,file,line,context}:
  formatPrice,src/components/Counter.tsx,2,"import { formatPrice } from '../lib';"
  formatPrice,src/components/Counter.tsx,12,"{cups} cups = {formatPrice(cups * CUP_CENTS)}"
  formatPrice,src/lib/analytics.js,4,"return { event: 'purchase', value: formatPrice(cents, 'EUR') };"
  ...
  Cart.total,src/components/CartSummary.tsx,10,setTotal(cart.total());
  Cart.total,src/hooks/useCart.ts,35,"total: cart.total(),"
  ...
blind_spots[1]{symbol,file,line,reason}:
  Cart.total,src/components/CartSummary.tsx,16,string key 'total' on a type without that member
elapsed_ms: 679
help[5]:
  - "Run `ts-axi refs src/lib/format.ts:5` for every Reference of formatPrice"
  - "Run `ts-axi callers src/lib/format.ts:5` for its call sites with the enclosing function"
  - "Run `ts-axi def src/lib/format.ts:5` for the changed declaration"
  - Run `ts-axi impact main...HEAD --grep` for textual matches the checker cannot see
  - Run `ts-axi impact main...HEAD --depth 2` for who calls the callers
```

(`...` marks rows cut from this README; the command prints all 20.)

Read-only: no lint, no refactor, no rename.

> **Status: early (v0.1.x).**

## Install

Requires Node.js 20+.

```sh
npm install -g ts-axi
```

Then tell your agent about it - one line in `CLAUDE.md` / `AGENTS.md`:

```
Use `ts-axi` to find definitions, references and callers in TypeScript/JavaScript code, and `ts-axi impact` to see what a diff affects before reviewing it.
```

Or install the on-demand Agent Skill (no per-session cost):

```sh
npx skills add cmosgh/ts-axi --skill ts-axi
```

## Commands

| Command | What it does |
| --- | --- |
| `ts-axi` | Home view: project root, tsconfig used (or implicit), source file count, test-file glob and match counts, git branch and dirty count, next steps. Under a second, exit 0 everywhere |
| `def <target>` | Declarations of a symbol by name (`save`, `User.save`, `path:line`): one match prints detail and body, several print a compact list, none prints `did_you_mean` |
| `refs <target>` | References of one symbol, grouped by file, with test counts. A class member that implements an interface (or overrides a base) member counts only its direct References; calls through the interface are `via_interface: n (Iface.member)`, sibling implementations are dropped, and an interface member reports `implementations: n`. `--limit`, `--kind calls`, `--via` (via rows with a `via` column), `--implementations` |
| `callers <target>` | Incoming calls of a function-like symbol, split the same way (`via_interface`, `--via`). `--depth 1..3` |
| `outline <file>` | Top-level declarations in source order, class members nested. `--exports` |
| `impact [<git-range> \| -]` | Declarations changed by the working tree (untracked files included; `--staged`), a git range (`main...HEAD`) or a unified diff on stdin (`bb-axi pr diff 42 --raw \| ts-axi impact -`), riskiest first: change class (`signature`, `removed`, `type`, `added`, `body`, `modified`), References outside the change set (direct only), a `via` count of calls through an interface or base member (`--via` lists them), test-file counts, `notes` (a signature change of a member that implements an interface member), `blind_spots`, `local_only`, `file_level` and `skipped` (non-TS files in the diff). `--limit`, `--depth 2..3`, `--grep`. Analyses the current checkout |
| `config` | Show effective settings with their source; `config set <key> <value>` and `config unset <key>` write `.ts-axi.json` |

`ts-axi <command> --help` prints a concise, complete flag reference. `-P <tsconfig>` selects a project on any command that may analyse types; `--json` prints the decoded payload.

<!-- TODO(phase 4): paste real examples for def / refs / outline / config from the fixture project. -->

## Monorepos

No configuration and no new files in your repo: ts-axi detects the layout from what is already there - `nx.json` (projects = `project.json` dirs, or a legacy `workspace.json`), `pnpm-workspace.yaml`, `package.json` `workspaces`, or a root `tsconfig.json` that only holds `references`. The home view prints `workspace: nx (14 projects)`.

Without `-P`, `refs`, `callers` and `impact` do not type-check the whole repo. They build the program from a subgraph: the declaring file (for `impact`, the touched files) plus every file that imports it, found by a fast text scan of import specifiers that follows `tsconfig.base.json` `paths`, workspace package names and `export * from` barrels. A caller in another project is found; the cost tracks the subgraph, not the repo. Each result says what was analysed:

```
scope: nx workspace - 30 of 5433 files (seeds 1; importers 29)
```

`scope_partial: true` means the importer scan stopped at its cap (50k files or 3 s); the help line says what is missing. `-P <tsconfig>` still analyses exactly one project; when it finds nothing, `found_outside_project` lists the importers outside it. A `-P` tsconfig that only holds `references` (an Nx project's `tsconfig.json`) is expanded to the configs it references: `tsconfig: libs/shared/tsconfig.json (2 referenced configs)`.

Files are listed with `git ls-files` (tracked plus untracked, gitignore applied), so nested worktrees and ignored copies are never analysed. Outside git, a directory walk skips `node_modules`, build output, `.claude`, `.cursor`, `.idea`, `.vscode` and any nested checkout.

## Test files

A file counts as a test by path pattern. Defaults: `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/test/**`, `**/tests/**`, `**/e2e/**`. The home view shows `test_globs` and `test_files` so a wrong rule is visible.

## `.ts-axi.json`

Optional, at the git root (or the current directory outside a repository). Manage it with `ts-axi config`, or edit it by hand:

```json
{ "testGlobs": ["**/*.it.ts", "packages/*/qa/**"], "testGlobsReplace": false, "project": "tsconfig.app.json" }
```

| Key | Meaning |
| --- | --- |
| `testGlobs` | Extra test-file globs, added to the defaults |
| `testGlobsReplace` | `true` makes `testGlobs` replace the defaults |
| `project` | Default tsconfig, relative to the repo root; `-P` overrides it |

Any other key is a `VALIDATION_ERROR` naming the valid ones. `--test-glob <glob>` adds a glob for one run.

## How it works

One dependency: the `typescript` compiler API (ADR in `docs/adr/0001-typescript-language-service-engine.md`).

- `outline`, `def` and the home view only parse files (`ts.createSourceFile`): no tsconfig needed, well under a second.
- `refs`, `callers` and `impact` build a `LanguageService` over the nearest `tsconfig.json` (or an implicit project of every source file when none exists, with a warning; in a monorepo or an implicit project of more than 3000 files, over the importer subgraph described above) and ask it for references and call hierarchy. Symbol identity comes from the checker, so `user.save` resolves to `User.save` through imports and re-exports.
- `impact` reads the "before" version of touched files with `git show` and compares signatures to classify each change (`added`, `removed`, `signature`, `body`, `type`, `modified`). Uses it cannot follow (access through `any`, dynamic string keys) are reported as `blind_spots`, never silently dropped.
- Type errors in the analysed project never block anything; they are reported as a `diagnostics` count.

Every semantic command starts cold and prints `elapsed_ms`.

## Development

```sh
corepack pnpm install
corepack pnpm run check   # typecheck, tests, build, skill freshness
```

`skills/ts-axi/SKILL.md` is generated: `corepack pnpm run build:skill`. See `PLAN.md` for the spec and `GLOSSARY.md` for the vocabulary.

## License

MIT
