import mongoose from 'mongoose';
const { Schema } = mongoose;
const id = Schema.Types.ObjectId;
function model(name, fields, indexes = []) {
  const schema = new Schema(fields, { timestamps: true, strict: 'throw' });
  for (const [keys, options] of indexes) schema.index(keys, options);
  return mongoose.model(name, schema);
}
export const User = model('User', { email: String, passwordHash: String, role: String, warehouseIds: [id] }, [[{ email: 1 }, { unique: true }]]);
export const Session = model('Session', { tokenHash: String, csrf: String, userId: id, expiresAt: Date }, [[{ tokenHash: 1 }, { unique: true }], [{ expiresAt: 1 }, { expireAfterSeconds: 0 }]]);
export const Warehouse = model('Warehouse', { name: String, timezone: String, dimensions: Schema.Types.Mixed, layoutVersion: Number, aisleGraph: Schema.Types.Mixed });
export const Product = model('Product', { sku: String, name: String, active: Boolean, reorderPoint: Number, leadTimeDays: Number, category: String }, [[{ sku: 1 }, { unique: true }]]);
export const Balance = model('Balance', { warehouseId: id, productId: id, binId: id, onHand: Number, reserved: Number, version: Number }, [[{ warehouseId: 1, productId: 1, binId: 1 }, { unique: true }]]);
export const Order = model('Order', { warehouseId: id, status: String, items: [Schema.Types.Mixed], allocations: [Schema.Types.Mixed], version: Number, createdBy: id, simulationRunId: id, pickedAt: Date, packedAt: Date, dispatchedAt: Date });
export const Task = model('Task', { warehouseId: id, orderId: id, assignedTo: id, status: String, version: Number, allocations: [Schema.Types.Mixed], completedAt: Date });
export const Movement = model('Movement', { warehouseId: id, productId: id, binId: id, orderId: id, actorId: id, type: String, quantity: Number, reason: String });
export const Command = model('Command', { actorId: id, route: String, key: String, requestHash: String, statusCode: Number, response: Schema.Types.Mixed, expiresAt: Date }, [[{ actorId: 1, route: 1, key: 1 }, { unique: true }], [{ expiresAt: 1 }, { expireAfterSeconds: 0 }]]);
export const Counter = model('Counter', { name: String, value: Number }, [[{ name: 1 }, { unique: true }]]);
export const Outbox = model('Outbox', { eventId: String, topic: String, partitionKey: String, envelope: Schema.Types.Mixed, publicationSequence: Number, publishedAt: Date, attempts: Number, lastError: String }, [[{ publicationSequence: 1 }, { unique: true }], [{ 'envelope.warehouseId': 1, 'envelope.eventType': 1, publicationSequence: 1 }, {}]]);
export async function connect() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all(Object.values(mongoose.models).map(m => m.init()));
  await Counter.updateOne({ name: 'publication' }, { $setOnInsert: { value: 0 } }, { upsert: true });
}
export { mongoose };

export const Bin = model('Bin', { warehouseId: id, rackCode: String, binCode: String, position: Schema.Types.Mixed, dimensions: Schema.Types.Mixed, aisleNodeId: String }, [[{ warehouseId: 1, binCode: 1 }, { unique: true }]]);
export const Processed = model('Processed', { consumerName: String, eventId: String }, [[{ consumerName: 1, eventId: 1 }, { unique: true }]]);
export const Demand = model('Demand', { warehouseId: id, productId: id, date: String, requestedUnits: { type: Number, default: 0 }, fulfilledUnits: { type: Number, default: 0 }, syntheticSeedUnits: Number, simulatorRequestedUnits: { type: Number, default: 0 }, observedRequestedUnits: { type: Number, default: 0 }, provenance: String }, [[{ warehouseId: 1, productId: 1, date: 1 }, { unique: true }]]);
export const Metric = model('Metric', { warehouseId: id, date: String, version: { type: Number, default: 0 }, orderCount: { type: Number, default: 0 }, unitsDispatched: { type: Number, default: 0 } }, [[{ warehouseId: 1, date: 1 }, { unique: true }]]);
export const Alert = model('Alert', { warehouseId: id, productId: id, status: String, version: Number, openedAt: Date, acknowledgedAt: Date, resolvedAt: Date }, [[{ warehouseId: 1, productId: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' } }]]);
export const Failure = model('Failure', { consumerName: String, topic: String, partition: Number, offset: String, event: Schema.Types.Mixed, attempts: Number, error: String, status: String }, [[{ consumerName: 1, topic: 1, partition: 1 }, { unique: true }]]);
export const Run = model('Run', { warehouseId: id, scenario: String, seed: Number, rate: Number, durationSeconds: Number, status: String, actorId: id, tick: { type: Number, default: 0 }, error: String }, [[{ warehouseId: 1 }, { unique: true, partialFilterExpression: { status: 'RUNNING' } }]]);

export const Observation = model('Observation', { warehouseId: id, productId: id, startDate: String, source: String }, [[{ warehouseId: 1, productId: 1 }, { unique: true }]]);
export const ForecastRun = model('ForecastRun', { warehouseId: id, actorId: id, throughDate: String, checkpoint: Number, status: String, active: Boolean, leaseUntil: Date, owner: String, results: [Schema.Types.Mixed], error: String, finishedAt: Date }, [[{ warehouseId: 1 }, { unique: true, partialFilterExpression: { active: true } }]]);
export const Forecast = model('Forecast', { warehouseId: id, productId: id, runId: id, version: Number, modelVersion: String, method: String, baselineMethod: String, fallbackReason: String, inputThroughDate: String, predictions: [Schema.Types.Mixed], provenance: Schema.Types.Mixed }, [[{ runId: 1, productId: 1 }, { unique: true }], [{ warehouseId: 1, productId: 1, createdAt: -1 }, {}]]);
