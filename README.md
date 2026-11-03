# ts-axi

Agent-ergonomic **TypeScript / JavaScript** code CLI, built on the [AXI](https://axi.md) principles: token-efficient [TOON](https://toonformat.dev/) output, minimal schemas, pre-computed aggregates, definitive empty states, structured errors and next-step hints.

It is **change-impact first**. When an agent reviews a diff, the expensive question is "what else does this touch?" - normally answered by grepping and reading dozens of files. `ts-axi impact` answers it from the compiler's own symbol resolution: for every declaration the diff changes, it lists the references *outside* the change set, grouped by file, with test coverage counted separately.

```
# ILLUSTRATIVE - synthetic names, not real output
$ ts-axi impact main...HEAD
changes: 2
changes[2]{symbol,kind,change,exported,refs_outside,tests}:
  UserService.save,method,signature,true,14,2
  formatName,function,body,true,3,0
refs[17]{file,line,context}:
  src/api/users.ts,41,"await users.save(input, { retry: true });"
  ...
help[2]:
  - ...
```

<!-- TODO(phase 4): replace the block above with real output from the fixture project. -->

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
| `refs <target>` | References of one symbol, grouped by file, with test counts. `--limit`, `--kind calls` |
| `callers <target>` | Incoming calls of a function-like symbol. `--depth 1..3` |
| `outline <file>` | Top-level declarations in source order, class members nested. `--exports` |
| `impact [<git-range> \| -]` | Declarations changed by the working tree (`--staged`), a git range (`main...HEAD`) or a unified diff on stdin (`bb-axi pr diff 42 --raw \| ts-axi impact -`), each with its outside references and blind spots |
| `config` | Show effective settings with their source; `config set <key> <value>` and `config unset <key>` write `.ts-axi.json` |

`ts-axi <command> --help` prints a concise, complete flag reference. `-P <tsconfig>` selects a project on any command that may analyse types; `--json` prints the decoded payload.

<!-- TODO(phase 4): paste real examples for def / refs / outline / config from the fixture project. -->

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
- `refs`, `callers` and `impact` build a `LanguageService` over the nearest `tsconfig.json` (or an implicit project of every source file when none exists, with a warning) and ask it for references and call hierarchy. Symbol identity comes from the checker, so `user.save` resolves to `User.save` through imports and re-exports.
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
