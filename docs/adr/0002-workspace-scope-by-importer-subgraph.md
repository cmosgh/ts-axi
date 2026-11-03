# 2. Monorepo scope: detected workspace + importer subgraph, no configured project list

Date: 2026-11-03

## Status

Accepted

## Context

In an Nx monorepo (~9.6k source files at the time) `refs` under `-P <one project's tsconfig>` found the Declaration but `refs_total: 0`: the only caller lived in another Nx project. Without `-P` there was no useful tsconfig (no root one, or a references-only shell), so the implicit project was the whole tree - including gitignored copies in agent worktrees - and semantic commands were slow, ambiguous, or ran out of memory. In such repos almost every interesting Symbol is used from another project.

Options:

- **A configured project list** in `.ts-axi.json`. Rejected: ts-axi must never require new files in the repos it analyses, and a list goes stale.
- **The Nx project graph** (`nx graph` / `.nx` cache). Nx-only, needs a working install and a daemon or a slow graph computation, and dependency edges are per project, not per file.
- **One program over every tsconfig** (`references` built in order, or all files at once). Correct but costs the whole repo on every command.
- **Detection + an importer subgraph**: detect the layout from existing files, scan import specifiers as text to find who imports the file in question, and type-check only that subgraph.

## Decision

Detection, not configuration. `src/workspace.ts` recognises `nx`, `pnpm-workspaces`, `npm-workspaces`, `tsconfig-references`, `single` and `implicit` from files already in the repo and reads `paths` aliases and workspace package names. Files come from one `git ls-files` listing (fs walk with a fixed skip list outside git).

`src/importers.ts` builds a reverse import graph syntactically (regex over file text, no AST): relative paths, `paths` aliases, package names and subpath exports, barrels followed without spending a hop. Semantic commands without `-P` build their LanguageService from the seed files (declaring file, or touched files for `impact`) plus their importers (1 hop for `refs`/`callers`, 2 for `impact`), with the seed's own tsconfig options plus the workspace `paths`. TypeScript resolves everything those files import.

`-P` (and `.ts-axi.json` `project`) stays the explicit override: exactly one project, today's behaviour, with a hint that lists importers outside it when nothing is found.

## Consequences

- Cost tracks the subgraph, not the repo: the importer scan is bounded (50k files / 3 s, `scope_partial: true` when hit) and the program holds the seeds, their importers and what they import. A widely used file still pulls in a large program.
- Every semantic result prints a `scope:` line, so what was analysed is visible.
- Regex-level extraction misses computed specifiers (`require(name)`, `import(\`./${x}\`)`), aliases defined only in bundler configs, and References that reach a Symbol without importing its file (through an interface declared elsewhere, or a value passed in by a caller further away than the hop limit). Those are absent from the result, not reported as blind spots.
- All files in a subgraph program share one set of compiler options (the seed's); a type error that comes from mixing projects only shows in the `diagnostics` count of the touched files.
- The two-paths rule holds: the importer index is syntactic; only the final program is semantic.
