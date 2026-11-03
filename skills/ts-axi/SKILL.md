---
name: ts-axi
description: "Navigate TypeScript and JavaScript code and measure change impact through the ts-axi CLI - find where a symbol is declared, list its references and callers, outline a file, and see which other code a diff affects. Use before reading many files to find callers or usages of a function, class or type; use `ts-axi impact` when reviewing a diff, a pull request or your own uncommitted changes."
user-invocable: false
---

# ts-axi

TypeScript/JavaScript symbol CLI for agents - definitions, references, callers, file outlines and change impact (what a diff affects) from the TypeScript compiler. Prefer it over grep for 'who uses this'.

Use ts-axi whenever a task needs to find definitions, references or callers in TypeScript/JavaScript code, or to judge what a change affects: reviewing a diff or pull request, checking the blast radius of an edit before committing.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- `npx -y ts-axi` for the project overview (tsconfig, file counts, git state)
- `npx -y ts-axi --help` for the command index
- `npx -y ts-axi <command> --help` for per-command flags and examples
