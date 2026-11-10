import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect, mongoose, Warehouse, Product, Observation, Demand, ForecastRun, Forecast, Outbox, Balance } from '../src/database.js';
import { event, execute } from '../src/commands.js';
import { project } from '../src/projections.js';
import { createForecastRun, processRun, claimRun, historyFor } from '../src/forecasts.js';
import { dateAdd, yesterday } from '../src/forecast-contract.js';
import { answer } from '../src/assistant.js';
const uri = process.env.TEST_MONGODB_URI;
test('ML transaction, checkpoint, retry and assistant integration', { skip: !uri }, async t => {
  if (!new URL(uri).pathname.startsWith('/warehouse_test')) throw new Error('Isolated warehouse_test database required');
  process.env.MONGODB_URI = uri;
  await connect();
  try {
    const warehouse = await Warehouse.create({ name: `ML-test-${randomUUID()}` });
    const product = await Product.create({ sku: randomUUID(), active: true, leadTimeDays: 7 });
    const product2 = await Product.create({ sku: randomUUID(), active: true, leadTimeDays: 7 });
    const warehouseId = String(warehouse._id), productId = String(product._id);
    const user = { _id: new mongoose.Types.ObjectId(), role: 'admin', warehouseIds: [warehouse._id] };
    await Balance.create({ warehouseId, productId, binId: new mongoose.Types.ObjectId(), onHand: 100, reserved: 0, version: 1 });
    await Observation.create({ warehouseId, productId, startDate: dateAdd(yesterday(), -27), source: 'test' });
    await Observation.create({ warehouseId, productId: product2._id, startDate: yesterday(), source: 'test' });
    await mongoose.connection.transaction(s => event(s, 'warehouse.demand.v1', 'DemandRequested', warehouseId, productId, 1, { productId, quantity: 9 }));
    const pending = await Outbox.findOne({ 'envelope.warehouseId': warehouseId });
    // Fixture represents a prior-day event that remains in the outbox.
    pending.envelope.occurredAt = `${yesterday()}T12:00:00.000Z`; pending.markModified('envelope'); await pending.save();
    let run;
    await t.test('concurrent same-key creation yields one run and overlap is rejected', async () => {
      const key = randomUUID(), input = { warehouseId };
      const submit = () => execute(user, '/forecast-runs', key, input, async s => ({ status: 202, body: { data: (await createForecastRun(warehouseId, user._id, s)).toObject() } }));
      const results = await Promise.all([submit(), submit()]);
      assert.equal(String(results[0].body.data._id), String(results[1].body.data._id));
      run = await ForecastRun.findById(results[0].body.data._id);
      await assert.rejects(mongoose.connection.transaction(s => createForecastRun(warehouseId, user._id, s)), { code: 'FORECAST_RUN_ACTIVE' });
    });
    await t.test('unpublished historical event blocks zeros until projection completes', async () => {
      await assert.rejects(historyFor(run, productId), { code: 'INGESTION_INCOMPLETE' });
      await project('demand-aggregation', pending.envelope);
      const result = await historyFor(run, productId);
      assert.equal(result.history.at(-1).requestedUnits, 9);
      assert.equal(result.provenance.zeroFilledDays, 27);
    });
    const infer = async input => ({ productId: input.productId, modelVersion: 'test', method: 'baseline', baselineMethod: 'moving_average', fallbackReason: null, inputThroughDate: input.history.at(-1).date, predictions: Array.from({ length: 7 }, (_, i) => ({ date: dateAdd(yesterday(), i + 1), predictedUnits: 2 })) });
    await t.test('partial success is durable and retry has no duplicate forecasts or events', async () => {
      run.owner = randomUUID(); run.leaseUntil = new Date(Date.now() + 60000); await run.save();
      await processRun(run, infer); await processRun(run, infer);
      assert.equal(await Forecast.countDocuments({ runId: run._id }), 1);
      assert.equal(await Outbox.countDocuments({ 'envelope.warehouseId': warehouseId, topic: 'warehouse.forecasts.v1' }), 1);
      assert.equal((await ForecastRun.findById(run._id)).status, 'PARTIAL');
    });
    await t.test('failed upstream refresh preserves successful forecast', async () => {
      const second = await mongoose.connection.transaction(s => createForecastRun(warehouseId, user._id, s));
      second.owner = randomUUID(); await second.save();
      await processRun(second, async () => { throw new Error('timeout'); });
      assert.equal(await Forecast.countDocuments({ warehouseId, productId }), 1);
      assert.equal((await ForecastRun.findById(second._id)).status, 'FAILED');
    });
    await t.test('expired worker lease resumes and fences off the old owner', async () => {
      const recovery = await mongoose.connection.transaction(s => createForecastRun(warehouseId, user._id, s));
      recovery.owner = 'old-worker'; recovery.leaseUntil = new Date(0); await recovery.save();
      const claimed = await claimRun();
      assert.equal(String(claimed._id), String(recovery._id));
      assert.notEqual(claimed.owner, recovery.owner);
      await processRun(recovery, infer);
      assert.equal(await Forecast.countDocuments({ runId: recovery._id }), 0);
      await processRun(claimed, infer);
      await processRun(claimed, infer);
      assert.equal(await Forecast.countDocuments({ runId: recovery._id }), 1);
    });
    await t.test('Groq tool round trip is grounded; provider failure stays unavailable', async () => {
      const key = process.env.GROQ_API_KEY, model = process.env.GROQ_MODEL;
      process.env.GROQ_API_KEY = 'test-only'; process.env.GROQ_MODEL = 'test-model';
      try {
        let count = 0;
        const fetcher = async (_, options) => {
          const request = JSON.parse(options.body);
          if (count === 0) { assert.ok(request.tools); assert.equal(request.tool_choice, 'required'); }
          else { assert.equal(request.tools, undefined); assert.deepEqual(request.response_format, { type: 'json_object' }); }
          return { ok: true, text: async () => JSON.stringify({ choices: [{ message: ++count === 1 ? { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'getWarehouseMetrics', arguments: '{}' } }] } : { content: JSON.stringify({ insights: [{ sourceId: 'source-1', explanation: 'backlog' }] }) } }] }) };
        };
        const result = await answer(user, { warehouseId, question: 'Explain backlog', mode: 'live' }, fetcher);
        assert.equal(result.provider, 'groq'); assert.match(result.explanations[0].text, /^0 orders/);
        await assert.rejects(answer(user, { warehouseId, question: 'backlog', mode: 'live' }, async () => ({ ok: false })), { code: 'ASSISTANT_UNAVAILABLE' });
        const demo = await answer(user, { warehouseId, question: 'Which products might run out?', mode: 'demo' });
        assert.equal(demo.provider, 'deterministic-demo');
      } finally { if (key) process.env.GROQ_API_KEY = key; else delete process.env.GROQ_API_KEY; if (model) process.env.GROQ_MODEL = model; else delete process.env.GROQ_MODEL; }
    });
  } finally { await mongoose.disconnect(); }
});
