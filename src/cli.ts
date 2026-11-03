import { runAxiCli } from "axi-sdk-js";
import { configCommand, CONFIG_HELP } from "./commands/config.js";
import { defCommand, DEF_HELP } from "./commands/def.js";
import { homeCommand } from "./commands/home.js";
import { impactCommand, IMPACT_HELP } from "./commands/impact.js";
import { outlineCommand, OUTLINE_HELP } from "./commands/outline.js";
import { callersCommand, CALLERS_HELP, refsCommand, REFS_HELP } from "./commands/refs.js";
import type { CommandContext } from "./context.js";
import { AxiError, exitCodeForError } from "./errors.js";
import { renderErrorOutput, setJsonMode, toJson } from "./render.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "TypeScript/JavaScript symbol CLI for agents - definitions, references, callers, file outlines and change impact (what a diff affects) from the TypeScript compiler. Prefer it over grep for 'who uses this'.";

export const TOP_HELP = `usage: ts-axi [command] [args] [flags]
commands[7]:
  (none)=project overview, def, refs, callers, outline, impact, config
targets:
  name (save), member (User.save) or position (src/a.ts:42 or src/a.ts:42:7)
flags[4]:
  -P <tsconfig> (after the command; default nearest tsconfig.json), --json (anywhere), --help, -v/-V/--version
examples:
  ts-axi
  ts-axi def User.save
  ts-axi refs src/models/user.ts:12
  ts-axi callers runSync --depth 2
  ts-axi outline src/models/user.ts
  ts-axi impact main...HEAD
  ts-axi refs --help
`;

const COMMAND_HELP: Record<string, string> = {
  def: DEF_HELP,
  refs: REFS_HELP,
  callers: CALLERS_HELP,
  outline: OUTLINE_HELP,
  impact: IMPACT_HELP,
  config: CONFIG_HELP,
};

type Handler = (args: string[], ctx: CommandContext) => Promise<string>;

function command(name: string, handler: Handler, ctx: CommandContext): (args: string[]) => Promise<string> {
  return async (args) => (args.includes("-h") ? (COMMAND_HELP[name] ?? "").trimEnd() : handler(args, ctx));
}

function formatError(error: unknown): { output: string; exitCode: number } {
  const axi =
    error instanceof AxiError
      ? error
      : new AxiError(error instanceof Error ? error.message : String(error), "UNKNOWN");
  return {
    output: `${renderErrorOutput(axi.message, axi.code, axi.suggestions)}\n`,
    exitCode: exitCodeForError(axi),
  };
}

export interface MainOptions {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
  /** Working directory for the run (default `process.cwd()`); tests pass a fixture path. */
  cwd?: string;
  /** Stdin for `impact -` (tests); default `process.stdin`. */
  stdin?: string;
}

export async function main(options: MainOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  // Global flag: stripped here because the SDK rejects flags before the command.
  const json = argv.includes("--json");
  setJsonMode(json);
  const stdout = options.stdout ?? process.stdout;
  const ctx: CommandContext = { cwd: options.cwd ?? process.cwd(), ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) };
  // home/config may take the context as an optional second parameter.
  const home: Handler = homeCommand;
  let buffered = "";
  try {
    await runAxiCli({
      argv: json ? argv.filter((a) => a !== "--json") : argv,
      stdout: json ? { write: (chunk: string) => (buffered += chunk) } : stdout,
      description: DESCRIPTION,
      version: VERSION,
      topLevelHelp: TOP_HELP,
      home: (args) => home(args, ctx),
      commands: {
        def: command("def", defCommand, ctx),
        refs: command("refs", refsCommand, ctx),
        callers: command("callers", callersCommand, ctx),
        outline: command("outline", outlineCommand, ctx),
        impact: command("impact", impactCommand, ctx),
        config: command("config", configCommand, ctx),
      },
      getCommandHelp: (name) => COMMAND_HELP[name],
      renderUnknownCommand: (name) =>
        `${renderErrorOutput(`unknown command '${name}'`, "VALIDATION_ERROR", [
          "commands: def, refs, callers, outline, impact, config (no command = project overview)",
          "Run `ts-axi --help` for examples",
        ])}\n`,
      formatError,
    });
  } finally {
    setJsonMode(false);
  }
  if (!json) return;
  if (stdout === process.stdout) {
    process.stdout.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
  }
  stdout.write(toJson(buffered));
}
