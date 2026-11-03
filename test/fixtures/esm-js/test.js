import assert from 'node:assert';
import limitQueue, {drain} from './index.js';

const one = limitQueue(1);
assert.ok(one(() => 1));
assert.ok(!one(() => 2));

const two = limitQueue(2);
assert.ok(two(() => 1));
assert.deepEqual(drain([1, 2]), [1, 2]);
