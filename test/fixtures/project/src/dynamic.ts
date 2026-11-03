import { runSync, syncAll } from "./services/sync";

export function saveAnything(x: unknown, obj: Record<string, () => boolean>): boolean {
  (x as any).save();
  return obj["save"]!();
}

export const kickoff = (): number => runSync("1,2");

export function nightly(): number {
  return syncAll([["a"], ["b"]]);
}
