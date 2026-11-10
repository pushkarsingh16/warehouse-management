import { Order, Task, Balance, Movement, Product, Bin, Alert, Observation } from './database.js';
import { AppError, requireTransition } from './domain.js';
import { event } from './commands.js';
export function scope(user, warehouseId, roles = ['admin', 'manager', 'operator', 'viewer']) {
  if (!roles.includes(user.role) || !user.warehouseIds.some(id => String(id) === String(warehouseId))) throw new AppError(403, 'FORBIDDEN', 'Warehouse operation is not allowed.');
}
export function expected(document, version) {
  if (document.version !== version) throw new AppError(409, 'VERSION_CONFLICT', 'Reload the latest record.');
}
export async function recordEvent(session, kind, type, document) {
  await event(session, `warehouse.${kind}.v1`, type, document.warehouseId, document._id, document.version, document.toObject());
}
export async function stock(user, input, session, receipt) {
  scope(user, input.warehouseId, ['admin', 'manager']);
  if (!await Product.exists({ _id: input.productId, active: true }).session(session) || !await Bin.exists({ _id: input.binId, warehouseId: input.warehouseId }).session(session)) throw new AppError(422, 'INVALID_LOCATION', 'Unknown product or warehouse bin.');
  await Observation.updateOne({ warehouseId: input.warehouseId, productId: input.productId }, { $setOnInsert: { startDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), source: 'observed' } }, { upsert: true, session });
  let balance = await Balance.findOne({ warehouseId: input.warehouseId, productId: input.productId, binId: input.binId }).session(session);
  if (!balance) balance = new Balance({ warehouseId: input.warehouseId, productId: input.productId, binId: input.binId, onHand: 0, reserved: 0, version: 0 });
  if (balance.onHand + input.quantity < balance.reserved) throw new AppError(409, 'RESERVED_STOCK', 'Adjustment would consume reserved stock.');
  balance.onHand += input.quantity;
  balance.version++;
  await balance.save({ session });
  await Movement.create([{ warehouseId: input.warehouseId, productId: input.productId, binId: input.binId, actorId: user._id, type: receipt ? 'RECEIVE' : 'ADJUST', quantity: input.quantity, reason: input.reason }], { session });
  await recordEvent(session, 'inventory', receipt ? 'InventoryReceived' : 'InventoryAdjusted', balance);
  return { status: 200, body: { data: balance.toObject() } };
}
export async function claim(user, taskId, input, session) {
  const task = await Task.findById(taskId).session(session);
  if (!task) throw new AppError(404, 'NOT_FOUND', 'Task not found.');
  scope(user, task.warehouseId, ['admin', 'operator']);
  expected(task, input.expectedVersion);
  requireTransition(task.status, 'OPEN');
  task.assignedTo = user._id;
  task.status = 'CLAIMED';
  task.version++;
  await task.save({ session });
  await recordEvent(session, 'pick-tasks', 'TaskClaimed', task);
  return { status: 200, body: { data: task.toObject() } };
}
export async function pick(user, taskId, input, session) {
  const task = await Task.findById(taskId).session(session);
  if (!task) throw new AppError(404, 'NOT_FOUND', 'Task not found.');
  scope(user, task.warehouseId, ['admin', 'operator']);
  if (String(task.assignedTo) !== String(user._id)) throw new AppError(403, 'NOT_ASSIGNED', 'Claim this task before picking.');
  expected(task, input.expectedVersion);
  if (!['CLAIMED', 'PICKING'].includes(task.status)) throw new AppError(409, 'INVALID_STATE', 'Task cannot be picked.');
  const allocation = task.allocations.find(a => String(a.balanceId) === input.balanceId);
  if (!allocation || allocation.confirmed + input.quantity > allocation.quantity) throw new AppError(409, 'INVALID_PICK', 'Quantity exceeds remaining allocation.');
  const order = await Order.findById(task.orderId).session(session);
  if (order.status === 'RESERVED') {
    order.status = 'PICKING';
    order.version++;
    await recordEvent(session, 'orders', 'PickingStarted', order);
  }
  requireTransition(order.status, 'PICKING');
  allocation.confirmed += input.quantity;
  task.markModified('allocations');
  task.status = 'PICKING';
  if (task.allocations.every(a => a.confirmed === a.quantity)) {
    task.status = 'COMPLETED';
    task.completedAt = new Date();
    order.status = 'PICKED';
    order.pickedAt = task.completedAt;
    order.version++;
    await recordEvent(session, 'orders', 'OrderPicked', order);
  }
  task.version++;
  await order.save({ session });
  await task.save({ session });
  await recordEvent(session, 'pick-tasks', 'PickConfirmed', task);
  return { status: 200, body: { data: task.toObject() } };
}
export async function transition(user, orderId, action, input, session) {
  const order = await Order.findById(orderId).session(session);
  if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found.');
  scope(user, order.warehouseId, action === 'cancellations' ? ['admin', 'manager'] : ['admin', 'manager', 'operator']);
  expected(order, input.expectedVersion);
  const task = await Task.findOne({ orderId }).session(session);
  if (user.role === 'operator' && String(task.assignedTo) !== String(user._id)) throw new AppError(403, 'NOT_ASSIGNED', 'Operation requires your assigned task.');
  const changes = { cancellations: ['RESERVED', 'CANCELLED', 'OrderCancelled'], packing: ['PICKED', 'PACKED', 'OrderPacked'], dispatches: ['PACKED', 'DISPATCHED', 'OrderDispatched'] };
  const [from, to, type] = changes[action];
  requireTransition(order.status, from);
  if (action !== 'packing') {
    for (const allocation of order.allocations) {
      const delta = { reserved: -allocation.quantity, version: 1 };
      if (action === 'dispatches') delta.onHand = -allocation.quantity;
      const balance = await Balance.findOneAndUpdate({ _id: allocation.balanceId, reserved: { $gte: allocation.quantity } }, { $inc: delta }, { session, new: true });
      if (!balance) throw new AppError(409, 'INVENTORY_CONFLICT', 'Reserved inventory is inconsistent.');
      await Movement.create([{ warehouseId: order.warehouseId, productId: allocation.productId, binId: allocation.binId, orderId, actorId: user._id, type: action === 'dispatches' ? 'DISPATCH' : 'RELEASE', quantity: allocation.quantity }], { session });
      await recordEvent(session, 'inventory', action === 'dispatches' ? 'StockDispatched' : 'StockReleased', balance);
    }
  }
  if (action === 'cancellations') {
    task.status = 'CANCELLED'; task.version++;
    await task.save({ session });
    await recordEvent(session, 'pick-tasks', 'TaskCancelled', task);
  }
  order.status = to;
  order.version++;
  if (action === 'packing') order.packedAt = new Date();
  if (action === 'dispatches') order.dispatchedAt = new Date();
  await order.save({ session });
  await recordEvent(session, 'orders', type, order);
  return { status: 200, body: { data: order.toObject() } };
}
export async function acknowledge(user, id, input, session) {
  const alert = await Alert.findById(id).session(session);
  if (!alert) throw new AppError(404, 'NOT_FOUND', 'Alert not found.');
  scope(user, alert.warehouseId, ['admin', 'manager']);
  expected(alert, input.expectedVersion);
  requireTransition(alert.status, 'ACTIVE');
  alert.acknowledgedAt = new Date(); alert.version++;
  await alert.save({ session });
  await recordEvent(session, 'alerts', 'AlertAcknowledged', alert);
  return { status: 200, body: { data: alert.toObject() } };
}
