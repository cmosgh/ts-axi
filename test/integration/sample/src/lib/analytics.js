import { formatPrice } from './format';

export function trackPurchase(cents) {
  return { event: 'purchase', value: formatPrice(cents, 'EUR') };
}
