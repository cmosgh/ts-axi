# 1. Analysis engine: TypeScript parser + LanguageService, no ts-morph, no tree-sitter

Date: 2026-11-03

## Status

Accepted

## Context

ts-axi exists to tell an agent what a change affects (`impact`), which needs Symbol identity: `user.save` in one file must resolve to `User.save` in another, through imports, re-exports and inheritance. Candidates:

- **TypeScript compiler API** (`typescript` package): TypeChecker and LanguageService give definitions, references, call hierarchy, outline and quick info - what an IDE uses. Pure JS. Needs a program over a `tsconfig.json`; cold start of seconds on thousands of files.
- **ts-morph**: ergonomic wrapper over the same API; adds wrapper-object overhead and lags TypeScript releases.
- **tree-sitter**: millisecond parses, no tsconfig, but no Symbol identity - references would be name matches, which is what `grep` already gives the agent. Native or wasm dependency.

TypeScript 7 is the Go port; the JavaScript compiler API stays on the 5.9/6.x line.

## Decision

A hybrid on one dependency, `typescript` 6.x (pinned by ts-axi, independent of the analysed project's version):

- `outline`, `def` and the home view use `ts.createSourceFile` only (syntax, no type-check, no tsconfig needed).
- `refs`, `callers` and `impact` create a `LanguageService` over the nearest `tsconfig.json` (or an implicit project) and ask it directly: `findReferences`, `getDefinitionAtPosition`, `provideCallHierarchyIncomingCalls`, `getQuickInfoAtPosition`.

Same AST in both paths, one internal model.

## Consequences

- Semantic commands pay a cold start per invocation; `elapsed_ms` is reported so this can be measured. A daemon or on-disk cache is deferred until measurements require it.
- Repositories without `tsconfig.json` still work (implicit project, with a warning).
- No native dependencies; install is ~20 MB because of `typescript`.
- Replacing the engine later means rewriting the semantic layer; the command surface and output schemas are engine-neutral on purpose.
