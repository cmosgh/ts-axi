export abstract class BaseParser {
  parse(raw: string): string {
    return raw.trim();
  }
}

export class LowerParser extends BaseParser {
  override parse(raw: string): string {
    return super.parse(raw).toLowerCase();
  }
}
