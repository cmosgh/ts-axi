export interface Money {
  cents: number;
  currency: string;
}

export function formatMoney(money: Money): string {
  const units = money.cents / 100;
  return `${units.toFixed(2)} ${money.currency}`;
}

export function roundCents(cents: number): number {
  return Math.round(cents);
}
