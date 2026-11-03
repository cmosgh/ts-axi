import type { FieldParser } from "./field-parser";

export class DateParser implements FieldParser {
  parse(raw: string): string {
    return raw.slice(0, 10);
  }
}
