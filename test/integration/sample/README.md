# ts-axi-sample

A small "Lantern Coffee" one-page Astro + React site. Names and content are synthetic.

It is vendored in ts-axi (`test/integration/sample/`) as its integration-test target: the code is
shaped to exercise `def`, `refs`, `callers`, `outline` and `impact` (barrel re-exports, a JS
consumer of TS, ambiguous names, dynamic-access blind spots, non-standard test file names via
`.ts-axi.json`).

```sh
pnpm install
pnpm dev     # local dev server
pnpm test    # vitest
pnpm build   # static build
```
