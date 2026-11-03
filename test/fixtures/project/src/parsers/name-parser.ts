import type { FieldParser } from "./field-parser";

export class NameParser implements FieldParser {
  parse(raw: string): string {
    return raw.trim();
  }
}
