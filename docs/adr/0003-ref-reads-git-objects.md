# 3. `--ref` reads git objects through a file-system seam

Date: 2026-11-05

## Status

Accepted

## Context

Triage agents need `def`, `refs`, `callers` and `outline` answers for the code that is deployed (`origin/main`, a release tag) while the local checkout sits on another branch or is dirty. Checking out is not an option: ts-axi is read-only on code, and an agent's checkout belongs to whoever is working in it. Options:

- **A worktree mirror** (`git worktree add` or an export into a cache dir). Correct, but it writes to disk and into `.git/worktrees`, needs a refresh step that can go stale, and leaves the question of who cleans up.
- **One `git show <rev>:<path>` per file.** No writes, but a spawn per file; `def` and the importer scan read every source file (~5k in a large Nx repo).
- **Git objects through a seam**: resolve the rev once, list the tree once, read blobs in batches, and answer every file-system question from that.

## Decision

Every read of repo content goes through `sourceFs()` (`src/fs.ts`): file listing, text, existence, directory entries, tsconfig parsing (a `ParseConfigHost` whose `readDirectory` is TypeScript's own `matchFiles` over the seam) and the LanguageService and module-resolution hosts. `diskFs` is today's behaviour; on disk the TS hosts get `ts.sys` itself.

`--ref <rev>` swaps in `gitTreeFs` (`src/gittree.ts`):

- `git rev-parse --verify <rev>^{commit}` once; everything after uses the SHA, so a concurrent `git fetch` cannot mix versions.
- One `git ls-tree -r -z --full-tree <sha>` gives files and directories. Submodules are skipped; symlinks resolve to a file inside the tree or are absent.
- Contents come from `git cat-file --batch`, synchronously (`execFileSync` with stdin), 2000 SHAs per call, frames split by byte length. Whole listings are prefetched before a scan (index, importer index, workspace manifests, templates, program root files); a single miss loads its source-like siblings with it. On a ~5k-file Nx repo all sources load in ~150 ms (500 per call: ~275 ms; 20000: ~147 ms).
- `GIT_NO_LAZY_FETCH=1` on every call: a partial clone never fetches; a missing blob is a `GIT_ERROR` that says so.
- Paths outside the repo root and paths under `node_modules` fall through to disk: TypeScript's lib files ship with ts-axi, and `node_modules` is not in git. The output says `node_modules: working tree (not in git)` when a file was read that way.
- `.ts-axi.json` stays on disk: it is local configuration, like `--test-glob`.

The active fs is a module-level value set by the command that parsed `--ref` and reset by `main()`, like `--json` mode: the reads sit in dozens of free functions (tsconfig chains, workspace detection, TS hosts), and threading a parameter through all of them would touch every signature for one flag.

## Consequences

- No writes, no refresh step, no cleanup; the answer is pinned to one commit and printed as `ref: <rev> @ <sha>`.
- The risk is a call site that reads disk directly and leaks working-tree content into a `--ref` answer. `test/ref-leak.test.ts` wraps `node:fs` and `ts.sys` and fails on any read below the repo root other than `node_modules`, `.ts-axi.json` and the settings `.git` probe; `test/ref.test.ts` compares `--ref HEAD` on a poisoned working tree with a clean checkout. New reads must go through `sourceFs()`.
- `impact` keeps reading the working tree: it already takes git ranges (`impact <ref>...HEAD`) and rejects `--ref`.
- Types from `node_modules` are the working tree's, not the ref's; when dependencies changed between the two, type-level answers can differ.
