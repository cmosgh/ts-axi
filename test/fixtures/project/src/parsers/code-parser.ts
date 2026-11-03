import type { FieldParser } from "./field-parser";

export class CodeParser implements FieldParser {
  parse(raw: string): string {
    return raw.toUpperCase();
  }
}
