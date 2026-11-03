import type { FieldParser } from "./field-parser";
import type { BaseParser } from "./base-parser";

export function parseField(parser: FieldParser, raw: string): string {
  return parser.parse(raw);
}

export function parseBase(parser: BaseParser, raw: string): string {
  return parser.parse(raw);
}
