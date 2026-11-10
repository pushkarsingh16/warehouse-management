import { z } from 'zod';
export const objectId = z.string().regex(/^[a-f0-9]{24}$/i);
export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s);
export const dateAdd = (date, days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
export const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
export const forecastInput = z.object({ warehouseId: objectId, productId: objectId, horizonDays: z.number().int().min(1).max(7), history: z.array(z.object({ date: day, requestedUnits: z.number().int().min(0).max(1e9) }).strict()).min(28).max(730) }).strict().refine(v => v.history.every((d, i) => !i || d.date === dateAdd(v.history[i - 1].date, 1)), 'History must be consecutive');
const response = z.object({ productId: objectId, modelVersion: z.string().min(1).max(200), method: z.enum(['pytorch', 'baseline']), baselineMethod: z.enum(['moving_average', 'same_weekday']).nullable(), fallbackReason: z.string().max(200).nullable(), inputThroughDate: day, predictions: z.array(z.object({ date: day, predictedUnits: z.number().finite().nonnegative() }).strict()).min(1).max(7) }).strict();
export function validateForecast(input, raw) {
  const output = response.parse(raw);
  if (output.productId !== input.productId || output.inputThroughDate !== input.history.at(-1).date || output.predictions.length !== input.horizonDays || output.predictions.some((p, i) => p.date !== dateAdd(output.inputThroughDate, i + 1))) throw new Error('Forecast response does not match request');
  if ((output.method === 'baseline') !== (output.baselineMethod !== null)) throw new Error('Invalid forecast method metadata');
  return output;
}
export async function requestForecast(input, fetcher = fetch, timeoutMs = 10000) {
  forecastInput.parse(input);
  const response = await fetcher(new URL('/v1/forecasts', process.env.ML_SERVICE_URL || 'http://ml:8000'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('FORECAST_SERVICE_UNAVAILABLE');
  const text = await response.text();
  if (text.length > 32000) throw new Error('Forecast response too large');
  return validateForecast(input, JSON.parse(text));
}
export function stockRisk(product, available, forecast, throughDate = yesterday()) {
  const base = { productId: String(product._id), availableUnits: available, leadTimeDays: product.leadTimeDays, incomingUnits: 0, assumption: 'No incoming inventory; heuristic, not probability', forecastId: forecast ? String(forecast._id) : null, forecastCreatedAt: forecast?.createdAt ?? null };
  if (!forecast) return { ...base, status: 'UNAVAILABLE' };
  if (forecast.inputThroughDate !== throughDate) return { ...base, status: 'STALE', inputThroughDate: forecast.inputThroughDate };
  let cumulative = 0, depletionDate = null;
  const horizon = Math.min(product.leadTimeDays, 7);
  const values = forecast.predictions.slice(0, horizon);
  for (const p of values) { cumulative += p.predictedUnits; if (!depletionDate && cumulative > available) depletionDate = p.date; }
  return { ...base, status: product.leadTimeDays > 7 ? 'UNSUPPORTED_LEAD_TIME' : cumulative > available ? 'SHORTFALL' : 'COVERED', coverageDays: horizon, expectedDemand: cumulative, projectedShortfall: Math.max(0, cumulative - available), depletionDate, fullLeadTimeRiskAvailable: product.leadTimeDays <= 7, inputThroughDate: forecast.inputThroughDate };
}
