import { DateParser } from "../parsers/date-parser";

export function dayOf(x: string): string {
  return new DateParser().parse(x);
}
