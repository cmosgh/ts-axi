import type { CommandContext } from "../context.js";
import { AxiError } from "../errors.js";

export const IMPACT_HELP = `usage: ts-axi impact [<git-range> | -] [flags]
input:
  (none) = working tree vs HEAD (staged + unstaged); --staged = index vs HEAD
  <git-range> = any git diff range (main...HEAD, abc123, v1..v2); - = unified diff on stdin
flags[6]:
  --staged, --depth <1-3> (callers_depthN[n]{file,count} for N > 1), --limit <1-500> (default 50 ref rows across the report), --grep (adds unresolved[n]{file,line,context} - textual matches that are not References), --test-glob <glob> (repeatable), -P <tsconfig>, --json
output:
  per Change = symbol, kind, change (added|removed|signature|body|type|modified), exported, refs_total, refs_outside, files, tests + refs[n]{file,line,context} outside the change set
  local_only = Changes with no Reference outside the change set; blind_spots[n]{symbol,reason} = uses the checker cannot follow
examples[4]:
  ts-axi impact
  ts-axi impact --staged
  ts-axi impact main...HEAD
  bb-axi pr diff 42 --raw | ts-axi impact -
`;

export async function impactCommand(_args: string[], _ctx: CommandContext): Promise<string> {
  throw new AxiError("impact: not implemented yet", "UNKNOWN");
}
