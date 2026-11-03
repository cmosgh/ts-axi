import { runSync } from "./sync";

export function checkRunSync(): boolean {
  return runSync(["a", "b"]) === 2;
}
