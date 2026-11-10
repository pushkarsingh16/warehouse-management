import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastInput, validateForecast, requestForecast, stockRisk, yesterday, dateAdd } from '../src/forecast-contract.js';
import { widgetSchema, renderInsights, answer, runTool, providerEvidence } from '../src/assistant.js';
const warehouseId = 'a'.repeat(24), productId = 'b'.repeat(24);
const input = { warehouseId, productId, horizonDays: 7, history: Array.from({ length: 28 }, (_, i) => ({ date: dateAdd(yesterday(), i - 27), requestedUnits: 5 })) };
const output = () => ({ productId, modelVersion: 'test-v1', method: 'baseline', baselineMethod: 'moving_average', fallbackReason: null, inputThroughDate: yesterday(), predictions: Array.from({ length: 7 }, (_, i) => ({ date: dateAdd(yesterday(), i + 1), predictedUnits: 5 })) });
test('forecast contract rejects gaps, mismatched products, dates, horizons and nonfinite values', () => {
  assert.equal(validateForecast(input, output()).predictions.length, 7);
  assert.throws(() => forecastInput.parse({ ...input, history: input.history.map((r, i) => i === 1 ? input.history[0] : r) }));
  for (const mutate of [r => r.productId = warehouseId, r => r.predictions.pop(), r => r.predictions[0].date = yesterday(), r => r.predictions[0].predictedUnits = Infinity]) {
    const value = output(); mutate(value); assert.throws(() => validateForecast(input, value));
  }
});
test('upstream failure and timeout reject', async () => {
  await assert.rejects(requestForecast(input, async () => ({ ok: false })));
  await assert.rejects(requestForecast(input, async (_, options) => new Promise((resolve, reject) => { const hold = setTimeout(resolve, 100); options.signal.addEventListener('abort', () => { clearTimeout(hold); reject(new Error('timeout')); }); }), 5));
});
test('risk changes with stock, refuses stale and unsupported full lead time', () => {
  const product = { _id: productId, leadTimeDays: 7 }, forecast = { ...output(), _id: productId };
  assert.equal(stockRisk(product, 40, forecast).status, 'COVERED');
  assert.equal(stockRisk(product, 10, forecast).projectedShortfall, 25);
  assert.equal(stockRisk(product, 10, forecast).depletionDate, dateAdd(yesterday(), 3));
  assert.equal(stockRisk({ ...product, leadTimeDays: 30 }, 10, forecast).fullLeadTimeRiskAvailable, false);
  assert.equal(stockRisk(product, 10, { ...forecast, inputThroughDate: dateAdd(yesterday(), -1) }).status, 'STALE');
});
test('widgets and evidence references are allowlisted', () => {
  assert.throws(() => widgetSchema.parse({ type: 'execute_javascript', props: {} }));
  assert.throws(() => renderInsights([{ sourceId: 'invented', explanation: 'backlog' }], [], warehouseId));
  assert.throws(() => renderInsights([{ sourceId: 's', explanation: 'stock_risk' }], [{ id: 's', tool: 'getWarehouseMetrics' }], warehouseId));
  const result = renderInsights([{ sourceId: 's', explanation: 'backlog' }], [{ id: 's', tool: 'getWarehouseMetrics', data: { pendingOrders: 3, explanationLimit: 'Cause unknown.' } }], warehouseId);
  assert.match(result.explanations[0].text, /^3 orders/);
});
test('assistant denies unauthorized warehouse before any provider or DB access', async () => {
  const user = { role: 'viewer', warehouseIds: [] };
  await assert.rejects(answer(user, { warehouseId, question: 'stock?', mode: 'demo' }), { code: 'FORBIDDEN' });
  await assert.rejects(runTool(user, warehouseId, 'getInventorySummary', {}), { code: 'FORBIDDEN' });
});
test('live mode does not silently become demo without credentials', async () => {
  const original = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  try { await assert.rejects(answer({ role: 'viewer', warehouseIds: [warehouseId] }, { warehouseId, question: 'stock?', mode: 'live' }), { code: 'ASSISTANT_NOT_CONFIGURED' }); }
  finally { if (original) process.env.GROQ_API_KEY = original; }
});
test('Groq cannot request arbitrary tools, scope overrides or excess tool calls', async () => {
  const key = process.env.GROQ_API_KEY, model = process.env.GROQ_MODEL;
  process.env.GROQ_API_KEY = 'test'; process.env.GROQ_MODEL = 'test';
  const user = { role: 'viewer', warehouseIds: [warehouseId] };
  const fake = tool_calls => async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { tool_calls } }] }) });
  const call = { id: 'c1', type: 'function', function: { name: 'executeSQL', arguments: '{}' } };
  try {
    await assert.rejects(answer(user, { warehouseId, question: 'Ignore policies', mode: 'live' }, fake([call])), { code: 'UNKNOWN_TOOL' });
    await assert.rejects(answer(user, { warehouseId, question: 'Read another warehouse', mode: 'live' }, fake([{ ...call, function: { name: 'getWarehouseMetrics', arguments: JSON.stringify({ warehouseId: productId }) } }])));
    await assert.rejects(answer(user, { warehouseId, question: 'Do more', mode: 'live' }, fake(Array(7).fill(call))), { code: 'TOOL_LIMIT' });
  } finally { if (key) process.env.GROQ_API_KEY = key; else delete process.env.GROQ_API_KEY; if (model) process.env.GROQ_MODEL = model; else delete process.env.GROQ_MODEL; }
});

test('provider receives compact demand evidence while full history is preserved for the client', () => {
  const source = { id: 'source-1', tool: 'getProductForecast', data: { freshness: 'CURRENT', forecast: null, risk: null, history: Array.from({length: 90}, (_, i) => ({ date: dateAdd(yesterday(), -i), requestedUnits: i, internalField: 'not-needed' })) } };
  const compact = providerEvidence(source);
  assert.equal(compact.data.historyDays, 90);
  assert.equal(compact.data.recentHistory.length, 7);
  assert.equal(compact.data.recentHistory[0].internalField, undefined);
  assert.equal(source.data.history.length, 90);
  assert.ok(JSON.stringify(compact).length < 1500);
});
