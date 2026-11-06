import { DESCRIPTION } from "./cli.js";

// Trigger string agents match against to auto-load the skill. Terse and
// outcome-focused so it fires on code-navigation and review intents.
export const SKILL_DESCRIPTION =
  "Navigate TypeScript and JavaScript code and measure change impact through the ts-axi CLI - find where a symbol is declared, " +
  "list its references and callers, outline a file, and see which other code a diff affects. Use before reading many files to find " +
  "callers or usages of a function, class or type; use `ts-axi impact` when reviewing a diff, a pull request or your own uncommitted changes, " +
  "and `ts-axi anchor` to check that review-comment file:line anchors are in the diff before posting them.";

// Hard cap so a regeneration cannot re-inflate the stub with CLI-owned
// guidance. The home view and --help output are the source of truth.
export const MAX_SKILL_MARKDOWN_CHARS = 2000;

/**
 * Render the installable SKILL.md. A discovery stub, not a copy of the CLI's
 * guidance: installed skills go stale, `ts-axi --help` does not.
 */
export function createSkillMarkdown(): string {
  const markdown = `---
name: ts-axi
description: ${JSON.stringify(SKILL_DESCRIPTION)}
user-invocable: false
---

# ts-axi

${DESCRIPTION}

Use ts-axi whenever a task needs to find definitions, references or callers in TypeScript/JavaScript code, or to judge what a change affects: reviewing a diff or pull request, checking the blast radius of an edit before committing.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- \`npx -y ts-axi\` for the project overview (tsconfig, file counts, git state)
- \`npx -y ts-axi --help\` for the command index
- \`npx -y ts-axi <command> --help\` for per-command flags and examples
`;

  if (markdown.length > MAX_SKILL_MARKDOWN_CHARS) {
    throw new Error(
      `generated SKILL.md is ${markdown.length} chars; keep it under ${MAX_SKILL_MARKDOWN_CHARS} and defer guidance to the CLI`,
    );
  }
  return markdown;
}
