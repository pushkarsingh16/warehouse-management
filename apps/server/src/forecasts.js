import { randomUUID } from 'node:crypto';
import { mongoose, Counter, Outbox, Processed, Observation, Demand, Product, Balance, Forecast, ForecastRun } from './database.js';
import { event } from './commands.js';
import { AppError } from './domain.js';
import { dateAdd, yesterday, requestForecast, stockRisk } from './forecast-contract.js';

export async function createForecastRun(warehouseId, actorId, session) {
  if (await ForecastRun.exists({ warehouseId, active: true }).session(session)) throw new AppError(409, 'FORECAST_RUN_ACTIVE', 'A refresh is already active.');
  // Serializes with every event-producing transaction, fencing in-flight writes.
  const counter = await Counter.findOneAndUpdate({ name: 'publication' }, { $inc: { value: 1 } }, { session, new: true });
  const [run] = await ForecastRun.create([{ warehouseId, actorId, throughDate: yesterday(), checkpoint: counter.value, status: 'QUEUED', active: true, results: [] }], { session });
  return run;
}

export async function assertComplete(run, session) {
  // All historical events remain in the outbox and processed ledger in this demo.
  // The lookup verifies actual projection effects, including unpublished events.
  const missing = await Outbox.aggregate([
    { $match: { publicationSequence: { $lte: run.checkpoint }, 'envelope.warehouseId': String(run.warehouseId), 'envelope.eventType': 'DemandRequested', 'envelope.occurredAt': { $lt: `${dateAdd(run.throughDate, 1)}T00:00:00.000Z` } } },
    { $lookup: { from: Processed.collection.name, let: { eid: '$eventId' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$eventId', '$$eid'] }, { $eq: ['$consumerName', 'demand-aggregation'] }] } } }], as: 'effects' } },
    { $match: { effects: { $size: 0 } } }, { $limit: 1 }, { $project: { _id: 1 } },
  ]).session(session);
  if (missing.length) throw new AppError(409, 'INGESTION_INCOMPLETE', 'Demand projection has not reached the history checkpoint.');
}

export async function historyFor(run, productId) {
  return mongoose.connection.transaction(async session => {
    await assertComplete(run, session);
    const observation = await Observation.findOne({ warehouseId: run.warehouseId, productId }).session(session).lean();
    if (!observation) throw new AppError(422, 'INSUFFICIENT_HISTORY', 'Observation period is unknown.');
    const start = observation.startDate > dateAdd(run.throughDate, -729) ? observation.startDate : dateAdd(run.throughDate, -729);
    const days = Math.floor((Date.parse(run.throughDate) - Date.parse(start)) / 86400000) + 1;
    if (days < 28) throw new AppError(422, 'INSUFFICIENT_HISTORY', 'At least 28 complete observation days are required.');
    const rows = await Demand.find({ warehouseId: run.warehouseId, productId, date: { $gte: start, $lte: run.throughDate } }).session(session).lean();
    const byDate = new Map(rows.map(r => [r.date, r]));
    return { history: Array.from({ length: days }, (_, i) => { const date = dateAdd(start, i); return { date, requestedUnits: byDate.get(date)?.requestedUnits ?? 0 }; }), provenance: { observationSource: observation.source, syntheticSeedUnits: rows.reduce((n, r) => n + (r.syntheticSeedUnits || 0), 0), simulatorRequestedUnits: rows.reduce((n, r) => n + (r.simulatorRequestedUnits || 0), 0), observedRequestedUnits: rows.reduce((n, r) => n + (r.observedRequestedUnits || 0), 0), unclassifiedRequestedUnits: rows.reduce((n, r) => n + Math.max(0, r.requestedUnits - (r.syntheticSeedUnits || 0) - (r.simulatorRequestedUnits || 0) - (r.observedRequestedUnits || 0)), 0), checkpoint: run.checkpoint, zeroFilledDays: days - rows.length } };
  });
}

export async function processRun(run, infer = requestForecast) {
  const productIds = await Observation.find({ warehouseId: run.warehouseId }).distinct('productId');
  const products = await Product.find({ _id: { $in: productIds }, active: true }).sort({ _id: 1 }).lean();
  for (const product of products) {
    const current = await ForecastRun.findOne({ _id: run._id, active: true, owner: run.owner });
    if (!current) return;
    if (current.results.some(r => r.productId === String(product._id))) continue;
    await ForecastRun.updateOne({ _id: run._id, owner: run.owner }, { $set: { leaseUntil: new Date(Date.now() + 60000) } });
    let failure = null;
    try {
      const { history, provenance } = await historyFor(run, product._id);
      const output = await infer({ warehouseId: String(run.warehouseId), productId: String(product._id), horizonDays: 7, history });
      await mongoose.connection.transaction(async session => {
        const owned = await ForecastRun.findOne({ _id: run._id, active: true, owner: run.owner }).session(session);
        if (!owned || owned.results.some(r => r.productId === String(product._id))) return;
        const previous = await Forecast.findOne({ warehouseId: run.warehouseId, productId: product._id }).sort({ version: -1 }).session(session);
        const [saved] = await Forecast.create([{ ...output, warehouseId: run.warehouseId, productId: product._id, runId: run._id, version: (previous?.version || 0) + 1, provenance }], { session });
        await event(session, 'warehouse.forecasts.v1', 'ForecastUpdated', run.warehouseId, saved._id, saved.version, { productId: String(product._id), inputThroughDate: saved.inputThroughDate });
        owned.results.push({ productId: String(product._id), status: 'SUCCEEDED', forecastId: String(saved._id) });
        await owned.save({ session });
      });
    } catch (error) {
      failure = ['INGESTION_INCOMPLETE', 'INSUFFICIENT_HISTORY'].includes(error.code) ? error.code : 'INFERENCE_FAILED';
    }
    if (failure === 'INGESTION_INCOMPLETE') {
      await ForecastRun.updateOne({ _id: run._id, owner: run.owner }, { $set: { status: 'WAITING_FOR_INGESTION', error: failure, leaseUntil: new Date(Date.now() + 30000) }, $unset: { owner: 1 } });
      return;
    }
    if (failure) await ForecastRun.updateOne({ _id: run._id, owner: run.owner }, { $push: { results: { productId: String(product._id), status: failure } } });
  }
  const final = await ForecastRun.findOne({ _id: run._id, owner: run.owner });
  if (!final) return;
  const failed = final.results.filter(r => r.status !== 'SUCCEEDED').length;
  await ForecastRun.updateOne({ _id: run._id, owner: run.owner }, { $set: { active: false, status: failed ? failed === final.results.length ? 'FAILED' : 'PARTIAL' : 'SUCCEEDED', finishedAt: new Date(), error: null } });
}

export async function claimRun() {
  return ForecastRun.findOneAndUpdate({ active: true, $or: [{ leaseUntil: { $lt: new Date() } }, { leaseUntil: null }] }, { $set: { owner: randomUUID(), leaseUntil: new Date(Date.now() + 60000), status: 'RUNNING' } }, { new: true, sort: { createdAt: 1 } });
}

export async function productForecast(warehouseId, productId) {
  const forecast = await Forecast.findOne({ warehouseId, productId }).sort({ version: -1 }).lean();
  const latestRun = await ForecastRun.findOne({ warehouseId }).sort({ createdAt: -1 }).lean();
  const refresh = latestRun ? { runId: latestRun._id, status: latestRun.status, error: latestRun.error, productResult: latestRun.results.find(r => r.productId === String(productId)) || null } : null;
  return { forecast, freshness: !forecast ? 'UNAVAILABLE' : forecast.inputThroughDate === yesterday() ? 'CURRENT' : 'STALE', refresh };
}
export async function riskRows(warehouseId, productId, limit = 50, cursor) {
  const ids = await Balance.find({ warehouseId, ...(productId ? { productId } : {}) }).distinct('productId');
  const products = await Product.find({ _id: { $in: ids, ...(cursor ? { $gt: cursor } : {}) }, active: true }).sort({ _id: 1 }).limit(limit + 1).lean();
  const data = [];
  for (const product of products.slice(0, limit)) {
    const balances = await Balance.find({ warehouseId, productId: product._id }).lean();
    const current = await productForecast(warehouseId, product._id);
    data.push({ sku: product.sku, reorderPoint: product.reorderPoint, lowStock: balances.reduce((n, b) => n + b.onHand - b.reserved, 0) <= product.reorderPoint, ...stockRisk(product, balances.reduce((n, b) => n + b.onHand - b.reserved, 0), current.forecast), refresh: current.refresh });
  }
  return { data, nextCursor: products.length > limit ? String(products[limit - 1]._id) : null, capturedAt: new Date().toISOString() };
}
