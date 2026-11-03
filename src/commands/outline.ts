import { existsSync, statSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";
import { bool, flag, parseArgs } from "../args.js";
import type { CommandContext } from "../context.js";
import { usageError } from "../errors.js";
import { hasGlobMagic, matchesGlob } from "../glob.js";
import { createSyntacticIndex, findRepoRoot, openProject, SOURCE_EXTENSIONS } from "../project.js";
import { block, helpBlock, out } from "../render.js";
import type { Declaration } from "../symbols.js";

const MAX_ROWS = 300;

export const OUTLINE_HELP = `usage: ts-axi outline <file | glob>... [flags]
flags[3]:
  --exported (alias --exports; exported Declarations only), -P <tsconfig> (file list for globs), --json
output:
  one file = file + decls[n]{line,kind,name,exported,signature}; several = decls[n]{file,line,kind,name,exported,signature}
  class members follow their class as Class.member; at most ${MAX_ROWS} rows
examples[3]:
  ts-axi outline src/models/user.ts
  ts-axi outline src/models/user.ts --exported
  ts-axi outline "src/services/**"
`;

const COMMAND = "ts-axi outline";

function isSource(path: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

export async function outlineCommand(args: string[], ctx: CommandContext): Promise<string> {
  const parsed = parseArgs(
    args,
    [
      { name: "--exported", alias: "--exports", boolean: true },
      { name: "-P" },
    ],
    COMMAND,
  );
  if (parsed.positionals.length === 0) {
    throw usageError("missing argument", [`usage: ${COMMAND} <file | glob>... [--exported]`]);
  }
  const exportedOnly = bool(parsed, "--exported");
  const override = flag(parsed, "-P");
  const root = findRepoRoot(ctx.cwd);
  const cwdPrefix = relative(root, resolve(ctx.cwd)).split(sep).join("/");

  const files: string[] = [];
  const globs = parsed.positionals.filter(hasGlobMagic);
  for (const raw of parsed.positionals.filter((p) => !hasGlobMagic(p))) {
    const abs = resolve(ctx.cwd, raw);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw usageError(`file not found: ${raw}`, ["pass a source file or a quoted glob such as \"src/**/*.ts\""]);
    }
    if (!isSource(abs)) throw usageError(`not a TypeScript/JavaScript source file: ${raw}`);
    files.push(abs);
  }

  // Only globs need the Project's file list; a plain path is parsed alone.
  const index = globs.length > 0
    ? openProject(ctx.cwd, override ? { override } : {}).index
    : createSyntacticIndex(root, { root, tsconfig: null, implicit: true, fileNames: files, options: {} });
  if (globs.length > 0) {
    const rooted = globs.map((g) => (cwdPrefix && !cwdPrefix.startsWith("..") ? posix.join(cwdPrefix, g.replace(/^\.\//, "")) : g));
    for (const file of index.files) if (rooted.some((g) => matchesGlob(index.rel(file), g))) files.push(file);
    if (files.length === 0) {
      return out(block({ files: 0, decls: 0 }), helpBlock([`No Project file matches ${globs.join(" ")}; paths are relative to the current directory`]));
    }
  }
  const unique = [...new Set(files)];

  const decls: Declaration[] = [];
  for (const file of unique) {
    for (const d of index.declarations(file)) {
      // Interface and enum members stay out of the outline; `def` shows them.
      if (d.parentName !== undefined && (d.kind === "enum-member" || isInterfaceMember(index.declarations(file), d))) continue;
      if (exportedOnly && !d.exported) continue;
      decls.push(d);
    }
  }
  const shown = decls.slice(0, MAX_ROWS);
  const single = unique.length === 1;
  const rows = shown.map((d) => ({
    ...(single ? {} : { file: d.file }),
    line: d.nameLine,
    kind: d.kind,
    name: d.qualifiedName,
    exported: d.exported,
    signature: d.signature,
  }));

  const help: string[] = [];
  if (decls.length > MAX_ROWS) help.push(`Showing ${MAX_ROWS} of ${decls.length} Declarations; pass fewer files or --exported`);
  const pick = shown.find((d) => d.exported && d.parentName === undefined) ?? shown[0];
  if (pick) {
    help.push(`Run \`ts-axi def ${pick.file}:${pick.nameLine}\` for its body`);
    help.push(`Run \`ts-axi refs ${pick.file}:${pick.nameLine}\` for its references`);
  }
  return out(
    block({
      ...(single ? { file: index.rel(unique[0]!) } : { files: unique.length }),
      decls: rows.length === 0 ? 0 : rows,
      ...(decls.length > MAX_ROWS ? { truncated: true, decls_total: decls.length } : {}),
    }),
    helpBlock(help),
  );
}

function isInterfaceMember(fileDecls: Declaration[], d: Declaration): boolean {
  return fileDecls.some((p) => p.qualifiedName === d.parentName && p.kind === "interface");
}
