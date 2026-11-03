import { formatMoney, type Money } from "@acme/shared";

export function invoiceLine(label: string, amount: Money): string {
  return `${label} - ${formatMoney(amount)}`;
}
