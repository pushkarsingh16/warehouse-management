import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base = process.env.API_URL || 'http://localhost:4000/api/v1';
const origin = process.env.APP_ORIGIN || 'http://localhost:5173';
let cookie, csrf;
async function request(path, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}), 'Idempotency-Key': randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(result)}`);
  if (path === '/auth/login') { cookie = response.headers.get('set-cookie').split(';')[0]; csrf = result.data.csrf; }
  return result.data;
}
await request('/auth/login', { email: 'admin@warehouse.test', password: process.env.SEED_PASSWORD || 'warehouse-demo-password-change-me' });
const me = await request('/auth/me');
const warehouseId = me.warehouseIds[0];
const inventory = await request(`/inventory?warehouseId=${warehouseId}`);
const balance = inventory.find(b => b.onHand - b.reserved >= 2);
assert.ok(balance, 'Seed inventory before running demo');
let order = await request('/orders', { warehouseId, items: [{ productId: balance.productId, quantity: 2 }] });
let task = (await request(`/pick-tasks?warehouseId=${warehouseId}`)).find(t => t.orderId === order._id);
assert.ok(task);
task = await request(`/pick-tasks/${task._id}/claims`, { expectedVersion: task.version });
const route = await request(`/pick-tasks/${task._id}/route`); assert.ok(route.stops.length);
for (const allocation of task.allocations) task = await request(`/pick-tasks/${task._id}/picks`, { expectedVersion: task.version, balanceId: allocation.balanceId, quantity: allocation.quantity });
order = await request(`/orders/${order._id}`);
order = await request(`/orders/${order._id}/packing`, { expectedVersion: order.version });
order = await request(`/orders/${order._id}/dispatches`, { expectedVersion: order.version });
assert.equal(order.status, 'DISPATCHED');
const cancel = await request('/orders', { warehouseId, items: [{ productId: balance.productId, quantity: 1 }] });
assert.equal((await request(`/orders/${cancel._id}/cancellations`, { expectedVersion: cancel.version })).status, 'CANCELLED');
const run = await request('/simulation/runs', { warehouseId, scenario: 'surge', seed: 42, rate: 1, durationSeconds: 15 });
console.log(JSON.stringify({ dispatchedOrderId: order._id, cancelledOrderId: cancel._id, simulationRunId: run._id, warehouseId }, null, 2));
