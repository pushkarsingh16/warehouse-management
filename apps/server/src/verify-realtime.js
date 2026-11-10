import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
const origin = process.env.APP_ORIGIN || 'http://localhost:5173';
const api = process.env.API_URL || 'http://localhost:4000';
const login = await fetch(`${api}/api/v1/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@warehouse.test', password: process.env.SEED_PASSWORD || 'warehouse-demo-password-change-me' }) });
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0];
const { data: { csrf } } = await login.json();
const headers = { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
const socket = io(api, { extraHeaders: { Origin: origin, Cookie: cookie }, transports: ['websocket'], reconnection: false });
async function wait(name) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), 15000);
    socket.once(name, value => { clearTimeout(timeout); resolve(value); });
  });
}
try {
  await wait('connect');
  const inventory = (await (await fetch(`${api}/api/v1/inventory`, { headers })).json()).data;
  const balance = inventory[0];
  for (let i = 0; i < 2; i++) {
    const notification = wait('inventory.updated');
    const response = await fetch(`${api}/api/v1/inventory/receipts`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ warehouseId: balance.warehouseId, productId: balance.productId, binId: balance.binId, quantity: 1, reason: 'Realtime verification' }) });
    assert.equal(response.status, 200);
    const message = await notification;
    assert.equal(message.id, balance._id); assert.ok(message.version > 1);
    if (i === 0) { socket.disconnect(); const connected = wait('connect'); socket.connect(); await connected; }
  }
  console.log('PASS authenticated Socket.IO inventory notifications and reconnect');
} finally { socket.disconnect(); }
