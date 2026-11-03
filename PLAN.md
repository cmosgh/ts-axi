# ts-axi plan

AXI CLI (https://axi.md) for TypeScript/JavaScript code: a queryable symbol index whose purpose is `impact` - an agent reviewing a change learns which other parts of the code it affects without reading dozens of files. Read-only: no lint, no refactor, no rename. Vocabulary: `GLOSSARY.md`. Engine choice: `docs/adr/0001`.

Built like `../bb-axi`: same `args.ts` / `render.ts` / `errors.ts` / `version.ts`, `runAxiCli` from `axi-sdk-js`, TOON output, generated `skills/ts-axi/SKILL.md`.

## Engine (ADR 0001)

- Single dependency `typescript` 6.x (JS line). Never native deps.
- **Syntactic path** (`outline`, `def`, home): `ts.createSourceFile` on candidate files only. No tsconfig required. Target: < 1 s.
- **Semantic path** (`refs`, `callers`, `impact`): `ts.createLanguageService` over the Project. Uses `findReferences`, `getDefinitionAndBoundSpan`, `provideCallHierarchyIncomingCalls`, `getQuickInfoAtPosition`, `getNavigationTree`.
- Project discovery: nearest `tsconfig.json` walking up from cwd (or from the target file's directory when a path is given); `-P <tsconfig>` overrides; `.ts-axi.json` `project` key as a per-repo default. No tsconfig anywhere → implicit project (`allowJs`, `strict: false`, every `.ts/.tsx/.js/.jsx/.mjs/.cjs` below the repo root minus `node_modules`, `dist`, `build`, `.git`) and a `warning: no tsconfig.json found - implicit project` line.
- Languages: `.ts .tsx .js .jsx .mts .cts .mjs .cjs`. No Vue/Svelte SFC.
- Excluded from results always: `node_modules`, `.d.ts` outside the project, files not in the Project.
- Cold start per command in v1; every semantic command prints `elapsed_ms`. On large projects (>5k files) `impact` builds the program from the touched files plus their transitive importers only (an importer index built syntactically from import specifiers), not the whole tsconfig. Daemon / disk cache, multi-tsconfig (`references`), vitest/jest config auto-detect = phase 2.
- Type errors in the analysed project never block anything: `diagnostics: <n>` (count only) when > 0 on the semantic path.

## Commands

| Command | Path | What |
|---|---|---|
| `ts-axi` | syntactic | home: project root, tsconfig used (or implicit), source file count, test-file pattern count and matching file count, git branch + dirty file count, next steps. < 1 s, exit 0 always, never fails outside a TS project (prints `project: none`). |
| `def <target>` | syntactic | Declarations of a Symbol by name. Exactly 1 match → detail: `file, line, kind, exported, signature` + body fenced with absolute file line numbers (first 60 lines, `--full` lifts, `(truncated, N lines total)` marker). >1 match → compact list `matches[n]{file,line,kind,exported,signature}` + help on how to narrow. 0 → `matches: 0`, `did_you_mean[≤5]` (names within edit distance 2 / same prefix among Declarations of the Project), exit 0. |
| `refs <target>` | semantic | References of ONE Symbol, grouped by file: `symbol, kind, declared_at, refs_total, files, tests` then `refs[n]{file,line,context}` (context ≤ 100 chars, trimmed), at most 50 location lines (`--limit`, max 500), `truncated: true` + exact total when cut. `--kind calls` is the same as `callers`. |
| `callers <target>` | semantic | Call-hierarchy incoming calls of a function-like Symbol, same shape as `refs` plus `caller` (the enclosing function/method name per row). `--depth N` (1..3): levels > 1 print `file:count` per caller, no locations. |
| `outline <file>` | syntactic | Top-level Declarations in source order, class members nested: `decls[n]{line,kind,name,exported,signature}`. `--exports` keeps exported only. Multiple files allowed (glob). |
| `impact [<git-range> \| -]` | semantic | See below. |
| `config` | - | `config` prints effective settings with their source (`default`, `.ts-axi.json`, `flag`); `config set <key> <value> [--replace]`, `config unset <key>` write `.ts-axi.json` at the repo root (idempotent, no `--confirm`). Keys: `test-globs` (repeatable/additive unless `--replace`), `project`. |

Global flags: `--json` (decoded TOON payload, like mysql-axi), `--help`/`-h` per command, `-v/--version` (fast path), `-P <tsconfig>` on every command that may go semantic.

### Targets

- Name: `save`, `User.save` (member of class/interface/enum/namespace), `--kind function|class|method|property|variable|interface|type|enum|namespace`, `--in <glob>` (restrict to files), `--exported`, `--fuzzy` (substring, case-insensitive).
- Position: `path:line[:col]` - the identifier at that position (col omitted → the first identifier declared or referenced on that line; several → list them, like an ambiguous name).
- `refs` / `callers` need exactly one Symbol: an ambiguous name prints the candidate Declarations (`matches[n]`) + `help` showing the disambiguated forms (`ts-axi refs src/a.ts:42` or `--in src/models`), exit 0, no analysis run.

### `impact`

Input, all normalised to `{ file → changed line ranges (after), file → changed line ranges (before), status added|modified|deleted|renamed }`:

- `impact` → working tree vs `HEAD` (staged + unstaged); `impact --staged` → index vs HEAD.
- `impact <range>` → any `git diff` range: `main...HEAD`, `abc123`, `v1..v2`.
- `impact -` → unified diff on stdin (e.g. `bb-axi pr diff 42 --raw | ts-axi impact -`). Paths are taken relative to the repo root (`a/`, `b/` prefixes stripped).
- `git` via `child_process` only. Not a git repo and no stdin diff → `GIT_ERROR` (exit 3) with the `impact -` alternative.

Before-version: `git show <base>:<path>` read in memory for touched files only; parsed syntactically to find the before-Declarations and Signatures. With stdin input and no repo, the before Signature is rebuilt from the `-` lines of the hunk when the whole declaration header is present; otherwise the change class is `modified`.

Per touched file: changed line ranges map to the innermost enclosing Declaration (top-level or class member). Lines outside any Declaration (imports, side-effect statements) are reported as `file-level` changes of that file, one row per file, no references.

Change classes (GLOSSARY): `added | removed | signature | body | type | modified`. Signature = declaration text without body, whitespace-normalised, comments stripped.

Output order: `signature` and `removed` that are exported first, then `type`, then `added`, then `body`, then `modified`, then `file-level`. Within a class, exported = the class is exported and the member is not `private`/`#private`.

Per Change: `symbol, kind, change, exported, refs_total, refs_outside, files, tests` + `refs[n]{file,line,context}` (only References outside the change set, grouped by file, global budget 50 rows across the whole report, `--limit` to 500; when cut, each symbol keeps its first rows and `truncated` says how many are missing). Changes whose every Reference is inside the change set are collapsed into one line `local_only: <n> (name, name, ...)` (max 10 names, then `+k`). `tests` = count of Test files among the referencing files; `tests: 0` on an exported `signature`/`body` change is a finding the agent should see.

`--depth N` (1..3): for N > 1 add `callers_depth2[n]{file,count}` etc. (counts only).

`blind_spots[n]{symbol,reason}`: the checker found a property access on `any`/`unknown` with the changed member's name, an element access with a string literal of that name, or the Symbol is reached by `export *` that the checker could not follow. Never a textual fallback by default. `--grep` adds `unresolved[n]{file,line,context}`: textual whole-word occurrences of changed names that are not References (max 20 rows).

Test files: default globs `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/test/**`, `**/tests/**`, `**/e2e/**`; `.ts-axi.json` `testGlobs` is added to the defaults (or replaces them with `"testGlobsReplace": true`); `--test-glob <glob>` (repeatable) adds at run time. The home view shows `test_globs: <n>` and `test_files: <n>` so a wrong rule is visible.

### `.ts-axi.json`

```json
{ "testGlobs": ["**/*.it.ts", "packages/*/qa/**"], "testGlobsReplace": false, "project": "tsconfig.app.json" }
```

Located at the git root (or cwd when not a repo). Unknown keys → `VALIDATION_ERROR` naming the valid set.

## Output rules

- TOON via `block()`, `helpBlock()`, `out()`; raw code only between `---` fences with absolute line numbers, format `  42 | const x = 1` (right-aligned number, ` | ` separator).
- `--json`: the same payload as an object; fenced text becomes a string field.
- Numbers stay numbers. Paths are repo-root-relative with `/`. No commas, colons or double quotes in TOON string values where avoidable (signatures may contain them: they are quoted by the encoder, accepted).
- Every result ends with a `help` block of concrete next commands with real values filled in (`ts-axi refs src/a.ts:42`, `ts-axi def User.save`).
- Empty states are definitive: `matches: 0`, `refs_total: 0`, `changes: 0`, exit 0.
- Exit codes: 0 ok/empty, 2 usage or validation, 1 internal failure (`UNKNOWN`), 3 not a git repo / git failure (`GIT_ERROR`).

## Tests

- `test/unit.test.ts`: target parsing, signature normalisation, change classification, diff parsing, test-glob matching, config merge.
- `test/commands.test.ts`: whole CLI through `main()` against `test/fixtures/project/` (a small synthetic TS project: a few modules, a class with members, a barrel re-export, a test file, a `.js` file, an `any` access as a blind spot). `impact` tests copy the fixture to a temp dir, `git init`, commit, edit, and run. Fixture names are synthetic.
- `pnpm run check` must pass on Node 22/24; the built CLI runs on Node 20.

## Phases

1. Scaffold, spec, glossary, ADR (done).
2. Engine + `def` / `refs` / `callers` / `outline` + `cli.ts` wiring; `config`, `.ts-axi.json`, test-glob matching, `git.ts`, `diff.ts`, home view, `skill.ts`, README (done).
3. `impact` (done). Shape as shipped: one `changed[n]{symbol,kind,change,exported,at,refs_total,refs_outside,files,tests}` table plus a flat `refs[n]{symbol,file,line,context}` table, `file_level[n]`, `blind_spots[n]{symbol,file,line,reason}`, `skipped[n]{file,reason}` for non-analysed files (`.astro`, `.css`, ...). `impact -` rebuilds the before version by reverse-applying hunks; untracked files count as `added`.
4. Unit + command tests (`pnpm test`) and the opt-in integration suite over the vendored Astro sample (`pnpm run test:integration`, `test/integration/README.md`) (done).
5. Phase 2 ideas (not now): daemon/cache, multi-tsconfig, vitest/jest config suggestion, token benchmark like mysql-axi.
