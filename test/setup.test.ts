import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFields } from "../src/args.js";
import { fixtureCopy, FIXTURE, runner } from "./helpers.js";

type Payload = Record<string, unknown>;
const toon = (stdout: string): Payload => decode(stdout, { strict: true }) as Payload;

describe("setup hooks", () => {
  const saved = {
    home: process.env["HOME"],
    argv1: process.argv[1],
    claude: process.env["CLAUDE_CONFIG_DIR"],
    codex: process.env["CODEX_HOME"],
    xdg: process.env["XDG_CONFIG_HOME"],
  };
  let home: string;
  const run = runner(FIXTURE);
  beforeEach(() => {
    // Never touch the developer's real agent config.
    home = realpathSync(mkdtempSync(join(tmpdir(), "ts-axi-home-")));
    process.env["HOME"] = home;
    delete process.env["CLAUDE_CONFIG_DIR"];
    delete process.env["CODEX_HOME"];
    delete process.env["XDG_CONFIG_HOME"];
  });
  afterEach(() => {
    const restore = (key: string, value: string | undefined) => (value === undefined ? delete process.env[key] : (process.env[key] = value));
    restore("HOME", saved.home);
    restore("CLAUDE_CONFIG_DIR", saved.claude);
    restore("CODEX_HOME", saved.codex);
    restore("XDG_CONFIG_HOME", saved.xdg);
    process.argv[1] = saved.argv1!;
  });
  const asInstalledBinary = (): void => {
    const bin = join(home, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ts-axi"), "");
    process.argv[1] = join(bin, "ts-axi");
  };

  it("fails instead of claiming success when nothing was written", async () => {
    // Under vitest argv[1] is not a ts-axi binary, so the SDK skips the install.
    const { stdout, exitCode } = await run("setup", "hooks");
    expect(exitCode).toBe(1);
    expect(toon(stdout)).toMatchObject({ code: "SETUP_FAILED", error: "no hooks were installed" });
  });

  it("installs, is a no-op on a repeat, reports status and removes only its own hook", async () => {
    asInstalledBinary();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const other = { type: "command", command: "./other.sh" };
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [other] }] } }));

    const first = await run("setup", "hooks");
    expect(first.exitCode).toBe(0);
    expect(toon(first.stdout)["hooks"]).toMatchObject({ status: "installed", integrations: "Claude Code; Codex; OpenCode" });
    expect((await run("setup", "hooks")).stdout).toContain("already installed (no-op)");
    expect((await run("setup", "status")).stdout).toContain("codex: installed");

    expect((await run("setup", "uninstall")).exitCode).toBe(0);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { hooks: { SessionStart: Array<{ hooks: unknown[] }> } };
    expect(settings.hooks.SessionStart.flatMap((g) => g.hooks)).toEqual([other]);
    const status = await run("setup", "status");
    expect(status.stdout).toContain("claude_code: not installed");
    expect(status.stdout).toContain("ts-axi setup hooks");
  });

  it("installs all three when run as the built dist entrypoint", async () => {
    const dist = join(home, "ts-axi", "dist", "bin");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "ts-axi.js"), "");
    process.argv[1] = join(dist, "ts-axi.js");
    const { stdout, exitCode } = await run("setup", "hooks");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("integrations: Claude Code; Codex; OpenCode");
  });

  it("does not call Codex installed while its hooks feature is off", async () => {
    asInstalledBinary();
    expect((await run("setup", "hooks")).exitCode).toBe(0);
    const config = join(home, ".codex", "config.toml");
    writeFileSync(config, readFileSync(config, "utf8").replace("hooks = true", "hooks = false"));
    const status = await run("setup", "status");
    expect(status.stdout).toContain("codex: installed (hooks feature off)");
    expect(status.stdout).toContain("Run `ts-axi setup hooks` to install the missing ones");
  });

  it("rejects an unknown action and a stray argument as usage errors", async () => {
    expect((await run("setup", "install")).exitCode).toBe(2);
    expect((await run("setup", "hooks", "extra")).exitCode).toBe(2);
  });
});

describe("home view with a broken .ts-axi.json", () => {
  it("still renders the overview with exit 0 and says the file is ignored", async () => {
    const dir = fixtureCopy();
    writeFileSync(join(dir, ".ts-axi.json"), "{bad");
    const { stdout, exitCode } = await runner(dir)();
    expect(exitCode).toBe(0);
    const data = toon(stdout);
    expect(data["settings"]).toMatch(/^\.ts-axi\.json \(ignored - not valid JSON\)$/);
    expect(data["source_files"]).toEqual(expect.any(Number));
    expect(data["help"]).toEqual(expect.arrayContaining([expect.stringContaining("Fix or delete .ts-axi.json")]));
    // def and config fail on a broken file, so they are not offered.
    expect(String(data["help"])).not.toContain("ts-axi config");
    expect(String(data["help"])).not.toContain("ts-axi def");
  });

  it("does the same for a project path in the file that does not exist", async () => {
    const dir = fixtureCopy();
    writeFileSync(join(dir, ".ts-axi.json"), JSON.stringify({ project: "missing/tsconfig.json" }));
    const { stdout, exitCode } = await runner(dir)();
    expect(exitCode).toBe(0);
    expect(toon(stdout)["settings"]).toContain("ignored - tsconfig not found");
  });
});

describe("outline over several files", () => {
  it("puts file and line into one at column", async () => {
    const data = toon((await runner(fixtureCopy())("outline", "src/models/*.ts")).stdout);
    const decls = data["decls"] as Payload[];
    expect(Object.keys(decls[0]!)).toEqual(["at", "kind", "name", "signature"]);
    expect(decls[0]!["at"]).toMatch(/^src\/models\/[a-z]+\.ts:\d+$/);
  });
});

describe("parseFields", () => {
  const available = ["kind", "exported", "files"] as const;
  it("matches any case, keeps the documented order and expands all", () => {
    expect(parseFields("Files, KIND", available)).toEqual(["kind", "files"]);
    expect(parseFields("all", available)).toEqual(["kind", "exported", "files"]);
    expect(parseFields(undefined, available)).toEqual([]);
  });
  it("names the valid fields on a typo", () => {
    expect(() => parseFields("kinds", available)).toThrow(/unknown field: kinds/);
    expect(() => parseFields("all,bogus", available)).toThrow(/unknown field: bogus/);
  });
});
