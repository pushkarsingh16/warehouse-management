import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { ForecastRun, Forecast, Demand } from './database.js';
import { execute } from './commands.js';
import { scope } from './operations.js';
import { AppError } from './domain.js';
import { objectId } from './forecast-contract.js';
import { createForecastRun, productForecast, riskRows } from './forecasts.js';
import { answer } from './assistant.js';
export function mlRoutes(app) {
  app.post('/api/v1/forecast-runs', async (req, res) => {
    const input = z.object({ warehouseId: objectId }).strict().parse(req.body);
    scope(req.user, input.warehouseId, ['admin', 'manager']);
    const result = await execute(req.user, req.path, req.get('idempotency-key'), input, async session => ({ status: 202, body: { data: (await createForecastRun(input.warehouseId, req.user._id, session)).toObject() } }));
    res.status(result.status).json(result.body);
  });
  app.get('/api/v1/forecast-runs/:id', async (req, res) => {
    const run = await ForecastRun.findById(objectId.parse(req.params.id)).lean();
    if (!run) throw new AppError(404, 'NOT_FOUND', 'Forecast run not found.');
    scope(req.user, run.warehouseId);
    delete run.owner;
    res.json({ data: run });
  });
  app.get('/api/v1/forecasts', async (req, res) => {
    const input = z.object({ warehouseId: objectId, productId: objectId }).strict().parse(req.query);
    scope(req.user, input.warehouseId);
    res.json({ data: await productForecast(input.warehouseId, input.productId) });
  });
  app.get('/api/v1/forecasts/:id', async (req, res) => {
    const forecast = await Forecast.findById(objectId.parse(req.params.id)).lean();
    if (!forecast) throw new AppError(404, 'NOT_FOUND', 'Forecast not found.');
    scope(req.user, forecast.warehouseId);
    res.json({ data: forecast });
  });
  app.get('/api/v1/stock-risks', async (req, res) => {
    const input = z.object({ warehouseId: objectId, productId: objectId.optional(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: objectId.optional() }).strict().parse(req.query);
    scope(req.user, input.warehouseId);
    res.json(await riskRows(input.warehouseId, input.productId, input.limit, input.cursor));
  });
  app.get('/api/v1/demand', async (req, res) => {
    const input = z.object({ warehouseId: objectId, productId: objectId, limit: z.coerce.number().int().min(1).max(730).default(90) }).strict().parse(req.query);
    scope(req.user, input.warehouseId);
    res.json({ data: await Demand.find({ warehouseId: input.warehouseId, productId: input.productId }).sort({ date: -1 }).limit(input.limit).lean() });
  });
  app.post('/api/v1/assistant/messages', rateLimit({ windowMs: 60000, limit: 10, keyGenerator: req => String(req.user._id), standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res) => {
    const result = await answer(req.user, req.body);
    console.info(JSON.stringify({ component: 'assistant', requestId: req.requestId, mode: result.mode, durationMs: result.durationMs, usage: result.usage, toolCalls: result.sources.length }));
    res.json({ data: result });
  });
}
