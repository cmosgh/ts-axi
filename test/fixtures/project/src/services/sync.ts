import { User } from "../models";
import { parse } from "./parse";

export function runSync(ids: string): number;
export function runSync(ids: string[]): number;
export function runSync(ids: string | string[]): number {
  const list = typeof ids === "string" ? parse(ids).map(String) : ids;
  return list.filter((id) => saveOne(id)).length;
}

function saveOne(id: string): boolean {
  const user = User.create(id);
  return user.save();
}

export function syncAll(batches: string[][]): number {
  let total = 0;
  for (const batch of batches) total += runSync(batch);
  return total;
}
