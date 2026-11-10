import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect, mongoose, Warehouse, Product, Balance, Processed, Demand, Failure, Alert } from './database.js';
import { kafka } from './kafka.js';
await connect();
const producer = kafka.producer(); await producer.connect();
async function until(check, label) {
  for (let i = 0; i < 120; i++) { const result = await check(); if (result) return result; await sleep(500); }
  throw new Error(`Timed out: ${label}`);
}
try {
  const warehouse = await Warehouse.create({ name: `Event verification ${randomUUID()}`, timezone: 'UTC' });
  const productId = new mongoose.Types.ObjectId();
  const demand = { eventId: randomUUID(), eventType: 'DemandRequested', schemaVersion: 1, occurredAt: new Date().toISOString(), warehouseId: String(warehouse._id), aggregateId: `${warehouse._id}:${productId}`, aggregateVersion: 1, payload: { productId: String(productId), quantity: 7 } };
  const publish = (topic, event) => producer.send({ topic, messages: [{ key: event.aggregateId, value: JSON.stringify(event) }] });
  await publish('warehouse.demand.v1', demand);
  await until(() => Processed.exists({ consumerName: 'demand-aggregation', eventId: demand.eventId }), 'first demand processing');
  await publish('warehouse.demand.v1', demand);
  await sleep(1500);
  assert.equal((await Demand.findOne({ warehouseId: warehouse._id })).requestedUnits, 7);
  const inventory = { ...demand, eventId: randomUUID(), eventType: 'InventoryReceived', aggregateId: String(new mongoose.Types.ObjectId()), payload: { productId: String(productId), onHand: 0, reserved: 0 } };
  await publish('warehouse.inventory.v1', inventory);
  const failure = await until(() => Failure.findOne({ consumerName: 'alerts', 'event.eventId': inventory.eventId, status: 'BLOCKED' }), 'dead-letter block');
  assert.ok(failure.error.includes('missing product'));
  await Product.create({ _id: productId, sku: randomUUID(), active: true, reorderPoint: 10 });
  await Balance.create({ warehouseId: warehouse._id, productId, binId: new mongoose.Types.ObjectId(), onHand: 0, reserved: 0, version: 1 });
  await Failure.updateOne({ _id: failure._id }, { $set: { status: 'RETRY' } });
  await until(() => Processed.exists({ consumerName: 'alerts', eventId: inventory.eventId }), 'replayed inventory');
  assert.ok(await Alert.exists({ warehouseId: warehouse._id, productId, status: 'ACTIVE' }));
  console.log('PASS real Kafka duplicate delivery, dead-letter blocking, source-offset recovery and alert projection');
} finally { await producer.disconnect(); await mongoose.disconnect(); }
