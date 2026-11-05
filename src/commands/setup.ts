import { readFileSync } from "node:fs";
import { installSessionStartHooks, sessionStartHookStatus, uninstallSessionStartHooks } from "axi-sdk-js";
import { bool, expectPositionals, parseArgs } from "../args.js";
import { axiError, usageError } from "../errors.js";
import { block, helpBlock, out } from "../render.js";

type Scope = "user" | "project";

export const SETUP_HELP = `usage: ts-axi setup <hooks|status|uninstall> [--project]
Manage the opt-in SessionStart integration that shows the ts-axi project overview to Claude Code, Codex and OpenCode at session start.
flags:
  --project (install into the current repository's agent config instead of your user config)
notes:
  The overview only reads the file tree and git status: no compiler run, no network, exit 0 in any directory (outside a TS/JS project it is a few lines)
  Only these hooks are touched; others in the same files are kept
examples[3]:
  ts-axi setup hooks
  ts-axi setup hooks --project
  ts-axi setup status
`;

// distEntrypoints names the built entrypoint explicitly; the SDK also infers it, so `node dist/bin/ts-axi.js setup hooks` installs either way.
const IDENTITY = { marker: "ts-axi", binaryNames: ["ts-axi"], distEntrypoints: ["dist/bin/ts-axi.js"] };

export async function setupCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub !== "hooks" && sub !== "status" && sub !== "uninstall") {
    throw usageError(sub ? `unknown setup action '${sub}'` : "missing setup action", [
      "Run `ts-axi setup hooks` to install, `ts-axi setup status` to inspect, `ts-axi setup uninstall` to remove",
    ]);
  }
  const command = `ts-axi setup ${sub}`;
  const parsed = parseArgs(rest, [{ name: "--project", boolean: true }], command);
  expectPositionals(parsed, 0, `${command} [--project]`);
  const scope: Scope = bool(parsed, "--project") ? "project" : "user";
  const flagHint = scope === "project" ? " --project" : "";

  if (sub === "status") {
    const status = sessionStartHookStatus({ ...IDENTITY, scope });
    // Codex runs hooks only with `[features] hooks = true` in the user config.toml.
    const codexOn = status.codex.installed && status.codex.userFeatureEnabled;
    const agents = { claude_code: status.claude.installed, codex: codexOn, opencode: status.opencode.installed };
    const missing = Object.values(agents).some((installed) => !installed);
    return out(
      block({
        hooks: {
          scope,
          claude_code: agents.claude_code ? "installed" : "not installed",
          codex: codexOn ? "installed" : status.codex.installed ? "installed (hooks feature off)" : "not installed",
          opencode: agents.opencode ? "installed" : "not installed",
        },
      }),
      helpBlock(missing ? [`Run \`ts-axi setup hooks${flagHint}\` to install the missing ones`] : []),
    );
  }

  if (sub === "uninstall") {
    const errors: string[] = [];
    uninstallSessionStartHooks({ ...IDENTITY, scope, onError: (message) => errors.push(message) });
    const left = installedAgents(scope);
    if (errors.length > 0 || left.length > 0) {
      throw axiError(`hooks not fully removed${left.length > 0 ? ` (still installed: ${left.join("; ")})` : ""}`, "SETUP_FAILED", errors);
    }
    return block({ hooks: { scope, status: "removed (or were not installed)" } });
  }

  const before = configSnapshot(scope);
  // The SDK skips exec paths it does not recognise and reports write failures only via onError, so verify by re-reading.
  const errors: string[] = [];
  installSessionStartHooks({ ...IDENTITY, scope, onError: (message) => errors.push(message) });
  const installed = installedAgents(scope, true);
  if (installed.length === 0) {
    throw axiError("no hooks were installed", "SETUP_FAILED", errors.length > 0 ? errors : [
      "Hooks are only installed from an installed binary, not npx: run `npm i -g ts-axi`, then `ts-axi setup hooks`",
    ]);
  }
  if (errors.length > 0 || installed.length < 3) {
    throw axiError(`hooks only partly installed (installed: ${installed.join("; ")})`, "SETUP_FAILED", errors);
  }
  if (configSnapshot(scope) === before) {
    return block({ hooks: { scope, status: "already installed (no-op)", integrations: installed.join("; ") } });
  }
  return out(
    block({ hooks: { scope, status: "installed", integrations: installed.join("; ") } }),
    helpBlock(["Restart the agent session to get the ts-axi project overview as ambient context"]),
  );
}

/** Contents of the agent config files the hooks live in; equal before and after = nothing was written. */
function configSnapshot(scope: Scope): string {
  const status = sessionStartHookStatus({ ...IDENTITY, scope });
  return [status.claude.path, status.codex.path, status.codex.userFeaturePath, status.opencode.path]
    .map((path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    })
    .join("\0");
}

/** `active`: count Codex only when its hooks feature is on (after an install); uninstall checks the entries alone. */
function installedAgents(scope: Scope, active = false): string[] {
  const status = sessionStartHookStatus({ ...IDENTITY, scope });
  const agents: Array<[string, boolean]> = [
    ["Claude Code", status.claude.installed],
    ["Codex", status.codex.installed && (!active || status.codex.userFeatureEnabled)],
    ["OpenCode", status.opencode.installed],
  ];
  return agents.filter(([, installed]) => installed).map(([agent]) => agent);
}
