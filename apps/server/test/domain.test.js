import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, requireTransition } from '../src/domain.js';
const balances = [{ _id: 'b1', binId: 'bin1', productId: 'p1', onHand: 8, reserved: 3 }, { _id: 'b2', binId: 'bin2', productId: 'p1', onHand: 4, reserved: 0 }];
test('splits allocation across bins without using reserved inventory', () => {
  const result = allocate([{ productId: 'p1', quantity: 7 }], balances);
  assert.deepEqual(result.map(a => a.quantity), [5, 2]);
  assert.equal(balances[0].reserved, 3);
});
test('rejects the entire allocation when a later product has insufficient stock', () => {
  assert.equal(allocate([{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }], balances), null);
});
test('allows exact available stock and rejects one extra unit', () => {
  assert.equal(allocate([{ productId: 'p1', quantity: 9 }], balances).length, 2);
  assert.equal(allocate([{ productId: 'p1', quantity: 10 }], balances), null);
});
test('invalid transitions return a conflict', () => assert.throws(() => requireTransition('DISPATCHED', 'PACKED'), { status: 409 }));
