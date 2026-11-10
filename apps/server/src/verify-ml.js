import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { io } from 'socket.io-client';
const api = process.env.API_URL || 'http://localhost:4000';
const origin = process.env.APP_ORIGIN || 'http://localhost:5173';
let cookie, csrf;
async function request(path, body, key = randomUUID()) {
  const response = await fetch(`${api}/api/v1${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}), 'Idempotency-Key': key }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
  if (path === '/auth/login') { cookie = response.headers.get('set-cookie').split(';')[0]; csrf = result.data.csrf; }
  return result;
}
await request('/auth/login', { email: 'admin@warehouse.test', password: process.env.SEED_PASSWORD || 'warehouse-demo-password-change-me' });
const warehouseId = (await request('/auth/me')).data.warehouseIds[0];
const socket = io(api, { extraHeaders: { Origin: origin, Cookie: cookie }, transports: ['websocket'], reconnection: false });
const messages = [];
socket.on('forecast.updated', value => messages.push(value));
try {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Socket connection timeout')), 15000); socket.once('connect', () => { clearTimeout(timer); resolve(); }); socket.once('connect_error', e => { clearTimeout(timer); reject(e); }); });
  const key = randomUUID();
  const run = (await request('/forecast-runs', { warehouseId }, key)).data;
  assert.equal((await request('/forecast-runs', { warehouseId }, key)).data._id, run._id);
  let completed;
  for (let i = 0; i < 120; i++) {
    completed = (await request(`/forecast-runs/${run._id}`)).data;
    if (!completed.active) break;
    await sleep(1000);
  }
  assert.equal(completed.active, false, 'Forecast job must finish');
  assert.equal(completed.results.filter(r => r.status === 'SUCCEEDED').length, 60);
  const products = (await request('/products?limit=100')).data.filter(p => /^DEMO-00[123]$/.test(p.sku));
  const inventory = (await request(`/inventory?warehouseId=${warehouseId}&limit=100`)).data;
  for (const product of products) {
    const balance = inventory.find(b => b.productId === product._id);
    const quantity = 100 - balance.onHand + balance.reserved;
    if (quantity > 0) await request('/inventory/receipts', { warehouseId, productId: product._id, binId: balance.binId, quantity, reason: 'ML surge verification replenishment' });
  }
  const before = (await request(`/stock-risks?warehouseId=${warehouseId}&limit=100`)).data;
  const surge = (await request('/simulation/runs', { warehouseId, scenario: 'surge', seed: 42, rate: 3, durationSeconds: 10 })).data;
  for (let i = 0; i < 30; i++) {
    const current = (await request(`/simulation/runs/${surge._id}`)).data;
    if (current.status === 'COMPLETED') break;
    assert.notEqual(current.status, 'FAILED', current.error);
    await sleep(1000);
  }
  const after = (await request(`/stock-risks?warehouseId=${warehouseId}&limit=100`)).data;
  for (const product of products) {
    const a = before.find(r => r.productId === product._id), b = after.find(r => r.productId === product._id);
    assert.equal(a.forecastId, b.forecastId);
    assert.ok(b.availableUnits < a.availableUnits);
    assert.ok(b.projectedShortfall > a.projectedShortfall);
  }
  const assistant = (await request('/assistant/messages', { warehouseId, question: 'Which products might run out?', mode: 'demo' })).data;
  assert.equal(assistant.provider, 'deterministic-demo');
  assert.equal(assistant.widgets[0].type, 'stock_risk_table');
  for (let i = 0; !messages.some(m => completed.results.some(r => r.forecastId === m.id)) && i < 20; i++) await sleep(1000);
  assert.ok(messages.some(m => completed.results.some(r => r.forecastId === m.id)), 'Real Kafka forecast Socket.IO notification');
  console.log(JSON.stringify({ pass: true, warehouseId, forecastRunId: run._id, successfulForecasts: 60, socketNotifications: messages.length, surgeRunId: surge._id, stockRiskChangedWithFixedForecast: true, assistantMode: assistant.mode }, null, 2));
} finally { socket.disconnect(); }
