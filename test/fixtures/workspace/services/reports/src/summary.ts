import { formatMoney } from "@acme/shared";

export type Formatter = typeof formatMoney;

export function summaryTitle(name: string): string {
  return `Report ${name}`;
}
