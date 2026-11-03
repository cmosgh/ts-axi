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

## Status (v0.1.4)

Early, but already used in real reviews. What the numbers say so far:

- **Correctness on the test corpus.** 163 unit and command tests over five synthetic fixtures (a TS project with an interface and three implementations, an Nx-style workspace with `tsconfig.base.json` paths and a pnpm workspace, a script-style JavaScript tree, a CommonJS package and an ESM package without tsconfig), plus 39 integration tests that run the built binary against a vendored Astro + React one-pager (`test/integration/sample`: barrel re-exports, JSX islands, custom hooks, a JS consumer of a TS export, a `.ts-axi.json` test glob). They pin exact line numbers, reference counts, test counts, change classes and the interface split.
- **A real monorepo** (Nx, 142 projects, ~5.4k source files after gitignore): `refs` on a service method finds its two callers in *another* project in 3-5 s without any flag; `impact` on a 7-file commit reports 15 changes with cross-project references in ~5 s; `callers` on a method that implements an interface shared by seven classes reports the 1 direct call plus the spec calls, where the raw compiler API returned 8 unrelated implementations. Before the workspace scope, the same `impact` ran out of memory.
- **Against grep, in characters an agent has to read** (same monorepo, measured by a reviewer session): `callers` 720 vs ~3.5k for the two greps a reviewer needs - and grep still leaves the interface ambiguity to the human; `impact` on a commit 4.7k vs ~7.3k for per-symbol greps plus the `git show --stat` needed to learn the symbol list. `def` on a very common name was *worse* than grep until nested git worktrees were excluded (96 matches, 92 of them copies); it is 4 now.

- **Plain JavaScript** (no tsconfig, measured on two public packages): on p-limit (ESM, `index.js` beside `index.d.ts`) `refs pLimit` went from 1 to 48 References, 35 of them in `test.js`, which now counts as a Test file; on express (CommonJS, `index.js` = `module.exports = require('./lib/express')`) `callers createApplication` went from 2 call sites in 2 files to 678 in 94 files, 67 of them Test files (every one of the 22 test files that does `require('..')` included). The rule: References are semantic wherever the checker can follow them, and every Symbol declared in JavaScript (or in an implicit project) also prints `textual: <n> matches in <m> files`; when the text names it more often than the checker found, `help` points at `--grep` for the rest. `refs app.render` on express is the honest case: the method sits on an untyped expando object, the checker finds 0 References, and the output says `textual: 132 matches in 21 files` with the `--grep` hint instead of a bare 0; `impact` adds a `textual` column for such a Change rather than calling it local-only.

Known limits: `.astro` / `.vue` / `.svelte` files are not analysed (they appear under `skipped`, and `--grep` searches them textually); every semantic command starts cold (0.3 s on a small project, 2-5 s on the monorepo, dominated by the library `.d.ts` files that barrels pull in); import specifiers are extracted textually, so computed specifiers and bundler-only aliases are missed.

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

### A review, end to end

```sh
ts-axi                                  # which project, how many files, how many are tests
ts-axi impact main...HEAD               # what the branch changes and who depends on it
ts-axi callers src/lib/format.ts:5      # the risky symbol: every call site with its enclosing function
ts-axi def src/lib/cart.ts:32           # read one declaration, numbered for inline comments
ts-axi outline src/lib/cart.ts          # the rest of the file, without reading it
```

Real output from the sample project (`test/integration/sample`):

```
$ ts-axi callers formatPrice
symbol: formatPrice
kind: function
declared_at: "src/lib/format.ts:5"
refs_total: 7
files: 6
tests: 2
refs[7]{file,line,caller,context}:
  src/components/Counter.tsx,12,Counter,"{cups} cups = {formatPrice(cups * CUP_CENTS)}"
  src/components/ProductCard.tsx,13,ProductCard,"<p>{formatPrice(item.priceCents)}</p>"
  src/lib/analytics.js,4,trackPurchase,"return { event: 'purchase', value: formatPrice(cents, 'EUR') };"
  src/lib/cart.it.ts,8,(top-level),expect(cart.total()).toBe(formatPrice(3700));
  src/lib/cart.ts,34,Cart.total,return formatPrice(cents);
  src/lib/format.test.ts,6,(top-level),expect(formatPrice(1850)).toBe('18.50 USD');
  src/lib/format.test.ts,9,(top-level),"expect(formatPrice(305, 'EUR')).toBe('3.05 EUR');"
elapsed_ms: 549
```

```
$ ts-axi def Cart.total
file: src/lib/cart.ts
line: 32
kind: method
exported: true
signature: "total(): string"
body:
---
  32 |   total(): string {
  33 |     const cents = this.items.reduce((sum, i) => sum + i.priceCents * i.qty, 0);
  34 |     return formatPrice(cents);
  35 |   }
---
```

The line numbers in front of the body are file lines, so an agent can cite or comment on them directly. An ambiguous name lists the candidates and the exact commands that narrow them:

```
$ ts-axi def parse
symbol: parse
matches[2]{file,line,kind,exported,signature}:
  src/lib/parse.ts,1,function,true,"export function parse(input: string): number"
  src/lib/query.ts,1,function,true,"export function parse(q: string): Record<string, string>"
help[4]:
  - "Run `ts-axi def src/lib/parse.ts:1` for the one in src/lib/parse.ts"
  - "Run `ts-axi def src/lib/query.ts:1` for the one in src/lib/query.ts"
  ...
```

### Interfaces are not conflated

`findReferences` in the compiler resolves a call like `parser.parse(raw)` (with `parser: FieldParser`) to every implementation of `parse`, and lists the other implementations' declarations as references. For a review that inflates the blast radius badly. ts-axi keeps the split:

```
$ ts-axi callers DateParser.parse
symbol: DateParser.parse
refs_total: 1
via_interface: 1 (FieldParser.parse)
refs[1]{file,line,caller,context}:
  src/services/dates.ts,4,dayOf,return new DateParser().parse(x);

$ ts-axi refs FieldParser.parse
refs_total: 1
via_implementations: 1 (DateParser.parse)
implementations: 3
refs[1]{file,line,context}:
  src/parsers/registry.ts,5,return parser.parse(raw);
```

### Script-style JavaScript

```
$ ts-axi outline client/app.js
decls[4]{line,kind,name,exported,signature}:
  6,function,CartCtrl,true,"controller CartCtrl($scope, priceService)"
  12,function,priceService,true,service priceService()
  13,method,priceService.sum,true,this.sum = function (items)
  17,function,cartBadge,true,directive cartBadge()
```

An edit inside `CartCtrl` is reported by `impact` as `CartCtrl body`, not as a file-level change. Names registered by a string have no identifier the checker can follow; `refs` says so and offers `--grep`. ui-router and ngRoute states are Declarations of kind `state` (`states.cart`, with callbacks as `states.cart.resolve.items`), so an edit inside a `resolve` names that callback. Directives, components, their `scope`/`bindings` keys, controllers and filters also get `templates: <n> usages in <m> files` (kebab-case elements and attributes, `ng-controller`, `| filter` in `.html`/`.htm`/`.ejs`/`.hbs`/`.njk`/`.pug`), a `templates` column in `impact`, and a changed template that uses a changed directive or binding is listed under `template_changes` instead of `skipped`.

## Monorepos

No configuration and no new files in your repo: ts-axi detects the layout from what is already there - `nx.json` (projects = `project.json` dirs, or a legacy `workspace.json`), `pnpm-workspace.yaml`, `package.json` `workspaces`, or a root `tsconfig.json` that only holds `references`. The home view prints `workspace: nx (14 projects)`.

Without `-P`, `refs`, `callers` and `impact` do not type-check the whole repo. They build the program from a subgraph: the declaring file (for `impact`, the touched files) plus every file that imports it, found by a fast text scan of import specifiers that follows `tsconfig.base.json` `paths`, workspace package names and `export * from` barrels. A caller in another project is found; the cost tracks the subgraph, not the repo. Each result says what was analysed:

```
scope: nx workspace - 30 of 5433 files (seeds 1; importers 29)
```

`scope_partial: true` means the importer scan stopped at its cap (50k files or 3 s); the help line says what is missing. `-P <tsconfig>` still analyses exactly one project; when it finds nothing, `found_outside_project` lists the importers outside it. A `-P` tsconfig that only holds `references` (an Nx project's `tsconfig.json`) is expanded to the configs it references: `tsconfig: libs/shared/tsconfig.json (2 referenced configs)`.

Files are listed with `git ls-files` (tracked plus untracked, gitignore applied), so nested worktrees and ignored copies are never analysed. Outside git, a directory walk skips `node_modules`, build output, `.claude`, `.cursor`, `.idea`, `.vscode` and any nested checkout.

## Test files

A file counts as a test by path pattern. Defaults: `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/test/**`, `**/tests/**`, `**/e2e/**`, `**/spec/**`, `**/test.*`, `**/*_test.*`. The home view shows `test_globs` and `test_files` so a wrong rule is visible.

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
- Module resolution keeps TypeScript's rules with two substitutions so References reach implementations: a `.d.ts` that has a JavaScript twin in the Project (`index.d.ts` beside `index.js`) resolves to the twin, and a CommonJS shim whose only statement is `module.exports = require('./x')` resolves to `./x`, so `require('..')` reaches the real function. A `.d.ts` twin that still ends up in the program is queried too and its References merged.
- Script-style JavaScript (AngularJS registrations and ui-router states, Meteor methods and helpers, `module.exports` objects, prototype methods, IIFE helpers) gets nested declarations with qualified names, so `outline` lists them and `impact` names the function an edit touches instead of a file-level change.
- Type errors in the analysed project never block anything; they are reported as a `diagnostics` count.

Every semantic command starts cold and prints `elapsed_ms`.

## Development

```sh
corepack pnpm install
corepack pnpm run check   # typecheck, tests, build, skill freshness
```

`skills/ts-axi/SKILL.md` is generated: `corepack pnpm run build:skill`. See `PLAN.md` for the spec, `GLOSSARY.md` for the vocabulary and `docs/adr/` for the two engine decisions (TypeScript LanguageService over ts-morph / tree-sitter; importer subgraph over a configured project list).

### Tests

| Suite | Runs | Covers |
| --- | --- | --- |
| `test/unit.test.ts`, `test/workspace.test.ts` | `pnpm test` | target parsing, signatures, change classification, diff parsing, settings, glob matching, reference classification, workspace detection, import resolution |
| `test/commands.test.ts` | `pnpm test` | the whole CLI through `main()` over five fixtures copied to temp git repos: `test/fixtures/project` (TS, interface + implementations, barrel, JS consumer, `any` access), `test/fixtures/workspace` (Nx + pnpm workspace, `paths`, references-only tsconfigs), `test/fixtures/legacy-js` (AngularJS, Meteor, prototype, IIFE, CommonJS), `test/fixtures/commonjs` (`require('..')` shim, expando methods, `.d.ts` twin), `test/fixtures/esm-js` (`"type": "module"`, `index.js` + `index.d.ts`) |
| `test/integration/*.test.ts` | `pnpm run test:integration` | the built binary against the vendored Astro + React sample in `test/integration/sample` (installs its own dependencies once; copied to a temp git repo per run, see `test/integration/README.md`) |

CI runs the first two on Node 22 and 24, the built CLI on Node 20, and the integration suite on Node 24.

## License

MIT
