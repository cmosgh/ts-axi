# ts-axi - contributor notes for agents

AXI-compliant TypeScript symbol CLI (definitions, references, callers, outlines, change impact). Read the AXI principles (https://axi.md) before changing output. `PLAN.md` is the spec, `GLOSSARY.md` the vocabulary, `docs/adr/` the decisions.

- **Output is the product.** Every stdout byte costs tokens. Default list schemas stay at 3-4 fields; extras go behind `--fields` (which also takes `all`). Avoid commas, colons and double quotes inside TOON string values where you control the text (use `;`, ` - `, single quotes); code signatures are the exception.
- **Handlers return strings** built with `block()` (TOON), `helpBlock()` (one suggestion per line) and `out()` from `src/render.ts`. Source code goes between `---` fences with absolute file line numbers, never inside a TOON string.
- **Two paths, one AST.** `outline`, `def` and the home view only parse (`ts.createSourceFile`), never type-check, never need a tsconfig. `refs`, `callers` and `impact` go through the `LanguageService` in `src/project.ts`. Do not add type-checking to the syntactic path: it has to stay under a second.
- **Read-only on code.** The only files ts-axi writes are `.ts-axi.json` (via `config set/unset`) and the agents' hook config (via `setup hooks/uninstall`, through axi-sdk-js, touching only its own entries). No `--confirm` flows exist because nothing is irreversible.
- **Every flag is declared.** `parseArgs()` in `src/args.ts` rejects unknown flags with the valid set inline. Validate input before building a program; usage errors are `VALIDATION_ERROR` (exit 2), git failures `GIT_ERROR` (exit 1).
- **Hints carry real values**: next-step commands in `help` use the paths, lines and names from the result (`ts-axi refs src/a.ts:42`), `<placeholders>` only for things the agent must choose.
- **Never a silent miss.** Truncation says how much is missing; unresolvable uses go to `blind_spots`; an implicit project prints a warning; `diagnostics: n` reports type errors as a count.
- **The home view runs at session start** (`setup hooks`): no program build, no git network calls, exit 0 in any directory - a broken `.ts-axi.json` is reported in `settings`, not thrown.
- `src/version.ts` is a leaf module (node builtins only) for the `--version` fast path.
- **Repo reads go through `sourceFs()`** (`src/fs.ts`), never `node:fs` or `ts.sys` directly: `--ref` swaps in the git tree, and `test/ref-leak.test.ts` fails on a read that bypasses it.
- Tests: `test/unit.test.ts` (pure logic), `test/commands.test.ts` (whole CLI via `main()` over `test/fixtures/project`) and `test/setup.test.ts` (hooks, with HOME in a temp dir - never the real agent config). Fixtures are synthetic - never commit real project, file or people names.
- `pnpm run check` must pass. `skills/ts-axi/SKILL.md` is generated: `pnpm run build:skill`.
