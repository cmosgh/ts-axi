export interface PriceRule {
  adjust(cents: number): number;
}

export class Discount implements PriceRule {
  adjust(cents: number): number {
    return cents - 100;
  }
}

export class Surcharge implements PriceRule {
  adjust(cents: number): number {
    return cents + 50;
  }
}

export function applyRules(rules: PriceRule[], cents: number): number {
  return rules.reduce((total, rule) => rule.adjust(total), cents);
}

export const promoCents = new Discount().adjust(1000);
