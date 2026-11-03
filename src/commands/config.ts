// Stub, implemented in phase 2 (PLAN.md: config).
export const CONFIG_HELP = `usage: ts-axi config [set <key> <value> [--replace] | unset <key>]`;

export async function configCommand(_args: string[]): Promise<string> {
  throw new Error("config: not implemented");
}
