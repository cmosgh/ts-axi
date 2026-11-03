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
