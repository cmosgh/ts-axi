# Integration suite

Opt-in tests that drive the built CLI (`dist/bin/ts-axi.js`) against `sample/`, a vendored Astro one-pager
with its own `package.json` and `pnpm-lock.yaml` (React islands, a barrel, a `.js` file, `.astro` pages,
an `.it.ts` test file marked by `.ts-axi.json`).

```sh
pnpm run test:integration   # builds, then runs vitest.integration.config.ts
```

`pnpm test` and `pnpm run check` skip it. The first run installs the sample's dependencies
(`corepack pnpm install --frozen-lockfile` in `sample/`, needs network).

## Why a temp copy

Run in place, the git root is the ts-axi repo: every path would start with `test/integration/sample/`
and the default `**/test/**` test glob would mark every file as a test. `prepareSample()` in `helpers.ts`
copies the sample (without `node_modules`, `dist`, `.astro`) to a fresh temp dir, symlinks the installed
`node_modules`, and makes it its own git repo with one commit (`base`). Tests edit and commit there freely;
`sample/` itself is never modified.

`.astro` files are not analysed by ts-axi; the tests assert that as known behaviour.
`prepareFixture()` does the same for a fixture without dependencies (`test/fixtures/legacy-js`).

## Token cost against grep (`token-compare.test.ts`)

Six agent tasks on the sample and on `test/fixtures/legacy-js`, each done with ts-axi and with the careful
grep-and-read workflow in `test/compare.ts`. It fails when ts-axi misses a grep hit that is real code (the failure
lists the missing `file:line` rows), when a task costs more than 0.3 of the grep tokens (tasks with `overRatio` say
why they cannot), or when a ratio grows past its pin in `token-compare.json` (+10%). The table goes to stdout and to
`$TOKEN_COMPARE_OUT` (default `ts-axi-token-compare.md` in the OS temp dir). `TOKEN_BUDGET_UPDATE=1` refreshes
the pins and the README table.

The same comparison on any local repo, never in CI:

```sh
corepack pnpm run build
corepack pnpm exec tsx scripts/token-compare.ts <repo> <tasks.json>
# tasks.json: [{ "name": "callers of a hot method", "kind": "callers", "symbol": "Service.method" },
#              { "name": "a fix", "kind": "impact", "symbol": "a,b", "range": "main...HEAD" }]
```

`kind` is `def`, `callers`, `refs` or `impact`; for impact, `symbol` lists the changed names an agent reads off the
diff. The script only runs ts-axi queries, `git grep`, `git diff` and file reads in `<repo>` (git without optional
locks) and prints to stdout. Unlisted hits are resolved with the checker, so other declarations of a common name are
told apart from real misses. Keep task files and output for private repos out of this repo.
