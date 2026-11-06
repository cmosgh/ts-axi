import { bool, expectPositionals, flag, parseArgs } from "../args.js";
import type { CommandContext } from "../context.js";
import { semanticFor } from "../scope.js";
import { textualScan, textualScanHint } from "./impact.js";
import { block, fenced, helpBlock, out } from "../render.js";
import { isFunctionLike, kindFromScriptElement, parseTarget, type Declaration, type SymbolGroup } from "../symbols.js";
import {
  BODY_LINES,
  declarationAt,
  filterSuffix,
  MATCH_ROWS,
  matchRows,
  narrowHints,
  numberedLines,
  open,
  positionStartDir,
  resolveNameTarget,
  resolvePosition,
  suggestions,
  TARGET_FLAGS,
  targetLabel,
  readFilters,
  useRef,
  type Opened,
} from "./common.js";

export const DEF_HELP = `usage: ts-axi def <name | Class.member | path:line[:col]> [flags]
flags[8]:
  --kind <function|class|method|property|variable|interface|type|enum|enum-member|namespace|state>, --in <dir|glob> (repeatable; restrict to files), --exported, --fuzzy (substring, case-insensitive), --full (whole body; default first ${BODY_LINES} lines), -P <tsconfig>, --ref <rev> (read the code at a git revision; working tree ignored), --json
output:
  1 match = file, line, kind, exported, signature + body fenced with file line numbers
  several = matches[n]{at,kind,signature} (at = path:line) (at most ${MATCH_ROWS}; matches_total + truncated past that) + the narrowing forms (--in, --kind, Class.member, --exported) with how many each keeps
  none = matches: 0 + did_you_mean
examples[5]:
  ts-axi def User
  ts-axi def User.save
  ts-axi def parse --in src/models
  ts-axi def src/services/sync.ts:12
  ts-axi def sav --fuzzy --exported
`;

const COMMAND = "ts-axi def";

function detail(ctx: Opened, decls: Declaration[], full: boolean, label: string, extra: Record<string, unknown> = {}): string {
  const primary = decls.find((d) => d.hasBody) ?? decls[0]!;
  const first = decls[0]!;
  const from = Math.min(...decls.map((d) => d.line));
  const to = Math.max(...decls.map((d) => d.endLine));
  const body = numberedLines(ctx.index.text(ctx.index.abs(primary.file)) ?? "", from, to, full ? undefined : BODY_LINES);
  const position = `${first.file}:${first.nameLine}`;
  const help = [`Run \`ts-axi refs ${position}\` for its references`];
  if (isFunctionLike(primary.kind)) help.push(`Run \`ts-axi callers ${position}\` for its call sites`);
  help.push(`Run \`ts-axi outline ${primary.file}\` for the rest of the file`);
  if (!full && to - from + 1 > BODY_LINES) help.unshift(`Run \`ts-axi def ${label} --full\` for the whole body`);
  return out(
    block({
      ...(ctx.warning ? { warning: ctx.warning } : {}),
      file: primary.file,
      line: first.nameLine,
      kind: primary.kind,
      exported: primary.exported,
      signature: first.signature,
      ...(decls.filter((d) => !d.hasBody).length > 0 ? { overloads: decls.filter((d) => !d.hasBody).length } : {}),
      ...extra,
    }),
    fenced("body", body),
    helpBlock(help),
  );
}

export async function defCommand(args: string[], ctx: CommandContext): Promise<string> {
  const parsed = parseArgs(args, [...TARGET_FLAGS, { name: "--full", boolean: true }], COMMAND);
  const [raw] = expectPositionals(parsed, 1, `${COMMAND} <name | Class.member | path:line[:col]> [flags]`);
  const f = readFilters(parsed);
  const target = parseTarget(raw!, { fuzzy: f.fuzzy });
  const full = bool(parsed, "--full");
  const project = flag(parsed, "-P");
  ctx = useRef(ctx, parsed);
  const opened = open(ctx.cwd, parsed, positionStartDir(ctx.cwd, target));
  const label = targetLabel(target);

  if (target.kind === "position") {
    const started = performance.now();
    const at = resolvePosition(opened.index, ctx.cwd, target);
    if (at.kind === "decl") return detail(opened, [at.decl], full, label);
    if (at.kind === "none") {
      return out(block({ matches: 0, reason: at.reason }), helpBlock([`Run \`ts-axi outline ${at.file}\` to see the Declarations of the file`]));
    }
    if (at.kind === "ambiguous") {
      return out(
        block({ position: label, identifiers: at.candidates }),
        helpBlock(at.candidates.slice(0, 3).map((c) => `Run \`ts-axi def ${at.file}:${c.line}:${c.col}\` for ${c.name}`)),
      );
    }
    // A reference, not a Declaration: ask the checker where it is declared.
    const { semantic } = semanticFor(opened, [at.abs], 0);
    const def = semantic.definitionAt(at.abs, at.pos);
    const decl = def && def.line > 0 ? declarationAt(opened.index, def.absFile, def.pos, kindFromScriptElement(def.kind)) : undefined;
    if (!decl) {
      return out(
        block({ matches: 0, reason: `no Declaration in the Project for '${at.name}' (external or built-in)` }),
        helpBlock([`Run \`ts-axi refs ${label}\` for its uses in the Project`]),
      );
    }
    const group = opened.index.declarations(def!.absFile).filter((d) => d.file === decl.file && d.qualifiedName === decl.qualifiedName);
    return detail(opened, group.length > 0 ? group : [decl], full, label, { elapsed_ms: Math.round(performance.now() - started) });
  }

  const groups: SymbolGroup[] = resolveNameTarget(opened, target, f);
  if (groups.length === 1) return detail(opened, groups[0]!.decls, full, label);
  if (groups.length === 0) {
    const suggested = suggestions(opened, target);
    const text = f.fuzzy ? 0 : textualScan(opened, target.member ?? target.name).length;
    const help = [...(text > 0 ? [textualScanHint(label, text)] : []), ...suggested.slice(0, 2).map((s) => `Run \`ts-axi def ${s}\``)];
    if (!f.fuzzy) help.push(`Run \`ts-axi def ${label} --fuzzy\` for substring matches`);
    if (f.kind || f.in.length > 0 || f.exported) help.push(`Drop --kind / --in / --exported to widen the search`);
    return out(
      block({
        ...(opened.warning ? { warning: opened.warning } : {}),
        matches: 0,
        ...(suggested.length > 0 ? { did_you_mean: suggested } : {}),
      }),
      helpBlock(help),
    );
  }
  return out(
    block({
      ...(opened.warning ? { warning: opened.warning } : {}),
      symbol: label,
      ...matchRows(groups),
    }),
    helpBlock(narrowHints(opened, "def", groups, f, `${label}${filterSuffix(f, project)}`, target)),
  );
}
