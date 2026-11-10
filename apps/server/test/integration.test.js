import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect, mongoose, User, Warehouse, Product, Balance, Bin, Order, Task, Outbox, Demand } from '../src/database.js';
import { execute, reserve } from '../src/commands.js';
import { claim, pick, transition, stock, scope } from '../src/operations.js';
import { project } from '../src/projections.js';
test('real replica-set transaction and projection recovery suite', { skip: !process.env.TEST_MONGODB_URI }, async t => {
  process.env.MONGODB_URI = process.env.TEST_MONGODB_URI;
  if (!new URL(process.env.MONGODB_URI).pathname.startsWith('/warehouse_test')) throw new Error('Use a warehouse_test database');
  await connect();
  try {
    const warehouse = await Warehouse.create({ name: randomUUID(), timezone: 'UTC' });
    const user = await User.create({ email: randomUUID(), role: 'admin', warehouseIds: [warehouse._id] });
    const product = await Product.create({ sku: randomUUID(), active: true, reorderPoint: 1 });
    const bin = await Bin.create({ warehouseId: warehouse._id, binCode: randomUUID() });
    const balance = await Balance.create({ warehouseId: warehouse._id, productId: product._id, binId: bin._id, onHand: 5, reserved: 0, version: 1 });
    const input = { warehouseId: String(warehouse._id), items: [{ productId: String(product._id), quantity: 5 }] };
    const submit = key => execute(user, '/orders', key, input, s => reserve(user, input, s));
    let winning;
    await t.test('competing orders cannot oversell', async () => {
      const results = await Promise.all([submit(randomUUID()), submit(randomUUID())]);
      assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
      winning = results.find(r => r.status === 201).body.data;
      assert.equal((await Balance.findById(balance._id)).reserved, 5);
    });
    await t.test('rejected result replays without additional demand', async () => {
      const key = randomUUID(); const first = await submit(key); const second = await submit(key);
      assert.equal(first.status, 409); assert.equal(second.status, 409);
      assert.equal(await Outbox.countDocuments({ topic: 'warehouse.demand.v1', 'envelope.warehouseId': String(warehouse._id) }), 3);
      await assert.rejects(execute(user, '/orders', key, { ...input, items: [] }, () => {}), { code: 'IDEMPOTENCY_CONFLICT' });
    });
    await t.test('claims, partial picking, packing and dispatch enforce state', async () => {
      let task = await Task.findOne({ orderId: winning._id });
      const claims = await Promise.allSettled([claimCommand(), claimCommand()]);
      function claimCommand() { return execute(user, '/claim', randomUUID(), {}, s => claim(user, task._id, { expectedVersion: 1 }, s)); }
      assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
      task = await Task.findById(task._id);
      await execute(user, '/pick', randomUUID(), {}, s => pick(user, task._id, { expectedVersion: task.version, balanceId: String(balance._id), quantity: 2 }, s));
      const order = await Order.findById(winning._id);
      await assert.rejects(execute(user, '/cancel', randomUUID(), {}, s => transition(user, order._id, 'cancellations', { expectedVersion: order.version }, s)), { code: 'INVALID_STATE' });
      task = await Task.findById(task._id);
      await execute(user, '/pick', randomUUID(), {}, s => pick(user, task._id, { expectedVersion: task.version, balanceId: String(balance._id), quantity: 3 }, s));
      for (const action of ['packing', 'dispatches']) {
        const current = await Order.findById(order._id); const key = randomUUID();
        const invoke = () => execute(user, action, key, {}, s => transition(user, current._id, action, { expectedVersion: current.version }, s));
        await invoke(); await invoke();
      }
      const final = await Balance.findById(balance._id); assert.equal(final.onHand, 0); assert.equal(final.reserved, 0);
    });
    await t.test('multi-item shortage leaves every balance untouched', async () => {
      const other = await Product.create({ sku: randomUUID(), active: true });
      const receipt = { warehouseId: String(warehouse._id), productId: String(product._id), binId: String(bin._id), quantity: 10, reason: 'test receipt' };
      await execute(user, '/receipt', randomUUID(), receipt, session => stock(user, receipt, session, true));
      const multi = { ...input, items: [{ productId: String(product._id), quantity: 1 }, { productId: String(other._id), quantity: 1 }] };
      assert.equal((await execute(user, '/orders', randomUUID(), multi, session => reserve(user, multi, session))).status, 409);
      assert.equal((await Balance.findById(balance._id)).reserved, 0);
    });
    await t.test('concurrent replay reserves once, adjustment respects reservations, cancellation releases once', async () => {
      const key = randomUUID();
      const results = await Promise.all([submit(key), submit(key)]);
      assert.equal(String(results[0].body.data._id), String(results[1].body.data._id));
      assert.equal((await Balance.findById(balance._id)).reserved, 5);
      const adjustment = { warehouseId: String(warehouse._id), productId: String(product._id), binId: String(bin._id), quantity: -6, reason: 'invalid adjustment' };
      await assert.rejects(execute(user, '/adjust', randomUUID(), adjustment, session => stock(user, adjustment, session, false)), { code: 'RESERVED_STOCK' });
      const order = results[0].body.data;
      const cancelKey = randomUUID();
      for (let i = 0; i < 2; i++) await execute(user, '/cancel', cancelKey, {}, session => transition(user, order._id, 'cancellations', { expectedVersion: order.version }, session));
      assert.equal((await Balance.findById(balance._id)).reserved, 0);
      assert.equal((await Task.findOne({ orderId: order._id })).status, 'CANCELLED');
    });
    await t.test('duplicate event has one projection effect', async () => {
      const e = await Outbox.findOne({ topic: 'warehouse.demand.v1', 'envelope.warehouseId': String(warehouse._id) });
      await project('demand-aggregation', e.envelope); await project('demand-aggregation', e.envelope);
      assert.equal((await Demand.findOne({ warehouseId: warehouse._id, productId: product._id })).requestedUnits, 5);
    });
    await t.test('warehouse access denied', () => assert.throws(() => scope({ role: 'admin', warehouseIds: [] }, warehouse._id), { code: 'FORBIDDEN' }));
  } finally { await mongoose.disconnect(); }
});
