import { formatMoney } from "@acme/shared";
import { invoiceLine } from "./invoice";

export const checks = [invoiceLine("fee", { cents: 100, currency: "EUR" }), formatMoney({ cents: 1, currency: "EUR" })];
