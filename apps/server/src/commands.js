import { context } from './context.js';
import { createHash, randomUUID } from 'node:crypto';
import { mongoose, Command, Counter, Outbox, Balance, Product, Order, Task, Movement, Observation } from './database.js';
import { allocate, AppError } from './domain.js';
export async function event(session, topic, eventType, warehouseId, aggregateId, aggregateVersion, payload) {
  const sequence = await Counter.findOneAndUpdate({ name: 'publication' }, { $inc: { value: 1 } }, { session, new: true });
  const eventId = randomUUID();
  await Outbox.create([{ eventId, topic, partitionKey: String(aggregateId), publicationSequence: sequence.value, attempts: 0, envelope: { eventId, eventType, schemaVersion: 1, correlationId: context.getStore()?.requestId || eventId, occurredAt: new Date().toISOString(), warehouseId: String(warehouseId), aggregateId: String(aggregateId), aggregateVersion, payload } }], { session });
}
export async function execute(user, route, key, input, operation) {
  if (!key || key.length > 200) throw new AppError(422, 'IDEMPOTENCY_KEY_REQUIRED', 'Supply an Idempotency-Key of at most 200 characters.');
  const identity = { actorId: user._id, route, key };
  const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await mongoose.connection.transaction(async session => {
        const existing = await Command.findOne(identity).session(session);
        if (existing) {
          if (existing.requestHash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Key was used with different input.');
          return { status: existing.statusCode, body: existing.response };
        }
        const result = await operation(session);
        await Command.create([{ ...identity, requestHash, statusCode: result.status, response: result.body, expiresAt: new Date(Date.now() + 7 * 86400000) }], { session });
        return result;
      }, { maxCommitTimeMS: 10000 });
    } catch (error) {
      if (error.code !== 11000 || attempt === 2) throw error;
    }
  }
}
export async function reserve(user, input, session) {
  const products = await Product.countDocuments({ _id: { $in: input.items.map(i => i.productId) }, active: true }).session(session);
  if (products !== input.items.length) throw new AppError(422, 'INVALID_PRODUCTS', 'Products must exist and be active.');
  const balances = await Balance.find({ warehouseId: input.warehouseId }).sort({ binId: 1, _id: 1 }).session(session).lean();
  const allocations = allocate(input.items, balances);
  for (const item of input.items) await Observation.updateOne({ warehouseId: input.warehouseId, productId: item.productId }, { $setOnInsert: { startDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), source: 'observed' } }, { upsert: true, session });
  for (const item of input.items) await event(session, 'warehouse.demand.v1', 'DemandRequested', input.warehouseId, `${input.warehouseId}:${item.productId}`, 1, { ...item, simulationRunId: input.simulationRunId ? String(input.simulationRunId) : null });
  if (!allocations) return { status: 409, body: { error: { code: 'INSUFFICIENT_STOCK', message: 'There is not enough available stock.' } } };
  const [order] = await Order.create([{ ...input, allocations, status: 'RESERVED', version: 1, createdBy: user._id }], { session });
  for (const allocation of allocations) {
    const balance = await Balance.findOneAndUpdate({ _id: allocation.balanceId, $expr: { $gte: [{ $subtract: ['$onHand', '$reserved'] }, allocation.quantity] } }, { $inc: { reserved: allocation.quantity, version: 1 } }, { session, new: true });
    if (!balance) throw new AppError(409, 'RESERVATION_CONFLICT', 'Retry the command.');
    await Movement.create([{ warehouseId: input.warehouseId, productId: allocation.productId, binId: allocation.binId, orderId: order._id, actorId: user._id, type: 'RESERVE', quantity: allocation.quantity }], { session });
    await event(session, 'warehouse.inventory.v1', 'StockReserved', input.warehouseId, balance._id, balance.version, balance.toObject());
  }
  const [task] = await Task.create([{ warehouseId: input.warehouseId, orderId: order._id, status: 'OPEN', version: 1, allocations: allocations.map(a => ({ ...a, confirmed: 0 })) }], { session });
  await event(session, 'warehouse.orders.v1', 'OrderReserved', input.warehouseId, order._id, 1, order.toObject());
  await event(session, 'warehouse.pick-tasks.v1', 'TaskCreated', input.warehouseId, task._id, 1, task.toObject());
  return { status: 201, body: { data: order.toObject() } };
}
