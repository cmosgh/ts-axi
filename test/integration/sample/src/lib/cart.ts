import { formatPrice } from './format';

export interface CartItem {
  id: string;
  name: string;
  priceCents: number;
  qty: number;
}

export type CartEvent = 'add' | 'remove' | 'clear';

export class Cart {
  private items: CartItem[] = [];

  static empty(): Cart {
    return new Cart();
  }

  add(item: CartItem): void {
    const existing = this.items.find((i) => i.id === item.id);
    if (existing) {
      existing.qty += item.qty;
    } else {
      this.items.push({ ...item });
    }
  }

  remove(id: string): void {
    this.items = this.items.filter((i) => i.id !== id);
  }

  total(): string {
    const cents = this.items.reduce((sum, i) => sum + i.priceCents * i.qty, 0);
    return formatPrice(cents);
  }
}
