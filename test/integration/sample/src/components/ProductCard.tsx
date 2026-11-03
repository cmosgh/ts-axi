import { formatPrice, type CartItem } from '../lib';

export interface ProductCardProps {
  item: CartItem;
  onAdd: (item: CartItem) => void;
}

export function ProductCard(props: ProductCardProps) {
  const { item, onAdd } = props;
  return (
    <article className="product">
      <h2>{item.name}</h2>
      <p>{formatPrice(item.priceCents)}</p>
      <button onClick={() => onAdd(item)}>Add to cart</button>
    </article>
  );
}
