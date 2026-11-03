import { formatMoney } from "@acme/shared";

export const price = formatMoney({ cents: 1999, currency: "EUR" });
