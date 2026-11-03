import { useCart } from '../hooks/useCart';
import { useLocalStorage } from '../hooks/useLocalStorage';

type CartBadgeProps = { label?: string };

export function CartBadge({ label = 'Cart' }: CartBadgeProps) {
  const { total } = useCart();
  const [seen, setSeen] = useLocalStorage<boolean>('lantern-badge-seen', false);

  return (
    <span className="badge" onClick={() => setSeen(true)}>
      {label}: {total}
      {seen ? '' : ' (new)'}
    </span>
  );
}
