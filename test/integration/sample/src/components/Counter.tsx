import { useState } from 'react';
import { formatPrice } from '../lib';

const CUP_CENTS = 350;

export default function Counter() {
  const [cups, setCups] = useState(0);
  return (
    <div className="counter">
      <button onClick={() => setCups(cups + 1)}>Add a cup</button>
      <span>
        {cups} cups = {formatPrice(cups * CUP_CENTS)}
      </span>
    </div>
  );
}
