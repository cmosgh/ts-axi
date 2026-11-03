import { parse as parseList } from "../format/parse";

export function parse(raw: string): number[] {
  return parseList(raw).map(Number);
}
