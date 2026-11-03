function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatPrice(cents: number, currency = 'USD'): string {
  const whole = Math.floor(cents / 100);
  const frac = pad2(cents % 100);
  return `${whole}.${frac} ${currency}`;
}

export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
