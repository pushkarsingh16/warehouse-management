import { z } from 'zod';
import { mongoose, Processed, Demand, Metric, Balance, Product, Alert } from './database.js';
import { recordEvent } from './operations.js';
const envelope = z.object({ eventId: z.string().uuid(), eventType: z.string(), schemaVersion: z.literal(1), occurredAt: z.string().datetime(), warehouseId: z.string().regex(/^[a-f0-9]{24}$/i), aggregateId: z.string(), aggregateVersion: z.number().int().nonnegative(), payload: z.record(z.string(), z.unknown()) });
export async function project(consumerName, raw) {
  const e = envelope.parse(raw);
  const allowed = { analytics: ['OrderReserved', 'PickingStarted', 'OrderPicked', 'OrderPacked', 'OrderDispatched', 'OrderCancelled'], 'demand-aggregation': ['DemandRequested', 'OrderReserved', 'PickingStarted', 'OrderPicked', 'OrderPacked', 'OrderDispatched', 'OrderCancelled'], alerts: ['InventoryReceived', 'StockReserved', 'StockReleased', 'StockDispatched', 'InventoryAdjusted'] };
  if (!allowed[consumerName]?.includes(e.eventType)) throw new Error('Unsupported event type');
  const date = e.occurredAt.slice(0, 10);
  await mongoose.connection.transaction(async session => {
    if (await Processed.exists({ consumerName, eventId: e.eventId }).session(session)) return;
    await Processed.create([{ consumerName, eventId: e.eventId }], { session });
    if (consumerName === 'demand-aggregation') {
      if (e.eventType === 'DemandRequested') {
        const item = z.object({ productId: z.string().regex(/^[a-f0-9]{24}$/i), quantity: z.number().int().positive() }).parse(e.payload);
        await Demand.updateOne({ warehouseId: e.warehouseId, productId: item.productId, date }, { $inc: { requestedUnits: item.quantity, simulatorRequestedUnits: e.payload.simulationRunId ? item.quantity : 0, observedRequestedUnits: e.payload.simulationRunId ? 0 : item.quantity } }, { session, upsert: true });
      }
      if (e.eventType === 'OrderDispatched') for (const item of z.array(z.object({ productId: z.string(), quantity: z.number().int().positive() })).parse(e.payload.items)) {
        await Demand.updateOne({ warehouseId: e.warehouseId, productId: item.productId, date }, { $inc: { fulfilledUnits: item.quantity } }, { session, upsert: true });
      }
    }
    if (consumerName === 'analytics' && ['OrderReserved', 'OrderDispatched'].includes(e.eventType)) {
      const delta = e.eventType === 'OrderReserved' ? { orderCount: 1 } : { unitsDispatched: z.array(z.object({ quantity: z.number().int().positive() })).parse(e.payload.items).reduce((n, i) => n + i.quantity, 0) };
      const metric = await Metric.findOneAndUpdate({ warehouseId: e.warehouseId, date }, { $inc: { ...delta, version: 1 } }, { session, upsert: true, new: true });
      await recordEvent(session, 'analytics', 'AnalyticsUpdated', metric);
    }
    if (consumerName === 'alerts') {
      const productId = z.string().regex(/^[a-f0-9]{24}$/i).parse(e.payload.productId);
      const product = await Product.findById(productId).session(session);
      if (!product) throw new Error('Event references missing product');
      const balances = await Balance.find({ warehouseId: e.warehouseId, productId }).session(session);
      const available = balances.reduce((n, b) => n + b.onHand - b.reserved, 0);
      let alert = await Alert.findOne({ warehouseId: e.warehouseId, productId, status: 'ACTIVE' }).session(session);
      if (available <= product.reorderPoint && !alert) {
        [alert] = await Alert.create([{ warehouseId: e.warehouseId, productId, status: 'ACTIVE', version: 1, openedAt: new Date() }], { session });
        await recordEvent(session, 'alerts', 'AlertOpened', alert);
      } else if (available > product.reorderPoint && alert) {
        alert.status = 'RESOLVED'; alert.version++; alert.resolvedAt = new Date();
        await alert.save({ session }); await recordEvent(session, 'alerts', 'AlertResolved', alert);
      }
    }
  });
}
