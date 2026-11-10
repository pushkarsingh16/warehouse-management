import { route } from './routing.js';
import { z } from 'zod';
import { Balance, Bin, Warehouse, Product, Order, Task, Alert, Demand, Metric, Run, Outbox, Failure } from './database.js';
import { execute } from './commands.js';
import { scope, stock, claim, pick, transition, acknowledge } from './operations.js';
import { AppError } from './domain.js';
export const id = z.string().regex(/^[a-f0-9]{24}$/i);
const version = z.object({ expectedVersion: z.number().int().positive() }).strict();
const inventory = z.object({ warehouseId: id, productId: id, binId: id, quantity: z.number().int().min(-100000).max(100000).refine(n => n !== 0), reason: z.string().min(1).max(500) }).strict();
export function routes(app) {
  function command(path, schema, operation) {
    app.post(`/api/v1${path}`, async (req, res) => {
      for (const value of Object.values(req.params)) id.parse(value);
      const input = schema.parse(req.body);
      const result = await execute(req.user, req.path, req.get('idempotency-key'), input, session => operation(req, input, session));
      res.status(result.status).json(result.body);
    });
  }
  command('/inventory/receipts', inventory.refine(v => v.quantity > 0), (r, v, s) => stock(r.user, v, s, true));
  command('/inventory/adjustments', inventory, (r, v, s) => stock(r.user, v, s, false));
  command('/pick-tasks/:id/claims', version, (r, v, s) => claim(r.user, r.params.id, v, s));
  command('/pick-tasks/:id/picks', version.extend({ balanceId: id, quantity: z.number().int().positive() }), (r, v, s) => pick(r.user, r.params.id, v, s));
  for (const action of ['cancellations', 'packing', 'dispatches']) command(`/orders/:id/${action}`, version, (r, v, s) => transition(r.user, r.params.id, action, v, s));
  command('/alerts/:id/acknowledgements', version, (r, v, s) => acknowledge(r.user, r.params.id, v, s));
  command('/products', z.object({ sku: z.string().min(1).max(80), name: z.string().min(1).max(200), reorderPoint: z.number().int().nonnegative(), leadTimeDays: z.number().int().min(1).max(365), category: z.string().max(80) }).strict(), async (r, v, s) => {
    if (r.user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Admin required.');
    const [product] = await Product.create([{ ...v, active: true }], { session: s });
    return { status: 201, body: { data: product } };
  });
  for (const [path, model] of [['inventory', Balance], ['orders', Order], ['pick-tasks', Task], ['alerts', Alert], ['products', Product]]) {
    app.get(`/api/v1/${path}`, async (req, res) => {
      const query = z.object({ warehouseId: id.optional(), productId: id.optional(), status: z.string().max(30).optional(), cursor: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(30), search: z.string().max(100).optional() }).strict().parse(req.query);
      const filter = model === Product ? {} : { warehouseId: { $in: req.user.warehouseIds } };
      if (query.warehouseId) { scope(req.user, query.warehouseId); filter.warehouseId = query.warehouseId; }
      if (model === Product) delete filter.warehouseId;
      if (query.productId && model === Balance) filter.productId = query.productId;
      if (query.status && [Order, Task, Alert].includes(model)) filter.status = query.status;
      if (query.cursor) filter._id = { $lt: query.cursor };
      if (query.search && model === Product) filter.sku = { $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      if (model === Task && req.user.role === 'operator') filter.$or = [{ status: 'OPEN' }, { assignedTo: req.user._id }];
      const rows = await model.find(filter).sort({ _id: -1 }).limit(query.limit + 1).lean();
      const more = rows.length > query.limit;
      const data = rows.slice(0, query.limit);
      res.json({ data, nextCursor: more ? String(data.at(-1)._id) : null });
    });
  }
  app.get('/api/v1/pick-tasks/:id/route', async (req, res) => {
    const task = await Task.findById(id.parse(req.params.id));
    if (!task) throw new AppError(404, 'NOT_FOUND', 'Task not found.');
    scope(req.user, task.warehouseId);
    if (req.user.role === 'operator' && String(task.assignedTo) !== String(req.user._id)) throw new AppError(403, 'FORBIDDEN', 'Assigned task required.');
    const warehouse = await Warehouse.findById(task.warehouseId);
    const bins = await Bin.find({ _id: { $in: task.allocations.map(a => a.binId) } });
    res.json({ data: route(warehouse.aisleGraph, bins) });
  });
  app.get('/api/v1/orders/:id', async (req, res) => {
    const order = await Order.findById(id.parse(req.params.id));
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found.');
    scope(req.user, order.warehouseId);
    res.json({ data: order });
  });
  for (const kind of ['layout', 'snapshot']) app.get(`/api/v1/warehouses/:id/${kind}`, async (req, res) => {
    const warehouseId = id.parse(req.params.id); scope(req.user, warehouseId);
    const warehouse = await Warehouse.findById(warehouseId);
    const bins = await Bin.find({ warehouseId }).lean();
    const balances = kind === 'snapshot' ? await Balance.find({ warehouseId }).lean() : undefined;
    res.json({ data: { warehouse, bins, balances, capturedAt: new Date().toISOString() } });
  });
  app.get('/api/v1/analytics/overview', async (req, res) => {
    const warehouseId = id.parse(req.query.warehouseId); scope(req.user, warehouseId);
    res.json({ data: { metrics: await Metric.find({ warehouseId }).sort({ date: -1 }).limit(30), demand: await Demand.find({ warehouseId }).sort({ date: -1 }).limit(1000), pendingOrders: await Order.countDocuments({ warehouseId, status: { $in: ['RESERVED', 'PICKING'] } }) } });
  });
  command('/simulation/runs', z.object({ warehouseId: id, scenario: z.enum(['normal', 'surge', 'low-stock', 'backlog']), seed: z.number().int().min(1).max(1000000), rate: z.number().int().min(1).max(5), durationSeconds: z.number().int().min(1).max(600) }).strict(), async (r, v, s) => {
    scope(r.user, v.warehouseId, ['admin']);
    if (process.env.SIMULATION_ENABLED !== 'true') throw new AppError(403, 'SIMULATION_DISABLED', 'Simulation is disabled.');
    const [run] = await Run.create([{ ...v, status: 'RUNNING', actorId: r.user._id }], { session: s });
    return { status: 201, body: { data: run } };
  });
  command('/simulation/runs/:id/stops', z.object({}).strict(), async (r, v, s) => {
    const run = await Run.findById(r.params.id).session(s);
    if (!run) throw new AppError(404, 'NOT_FOUND', 'Run not found.');
    scope(r.user, run.warehouseId, ['admin']); run.status = 'STOPPED'; await run.save({ session: s });
    return { status: 200, body: { data: run } };
  });
  app.get('/api/v1/simulation/runs/:id', async (req, res) => {
    const run = await Run.findById(id.parse(req.params.id));
    if (!run) throw new AppError(404, 'NOT_FOUND', 'Run not found.');
    scope(req.user, run.warehouseId, ['admin']);
    res.json({ data: run });
  });
  app.get('/api/v1/health/operations', async (req, res) => {
    if (req.user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Admin required.');
    res.json({ data: { oldestPending: await Outbox.findOne({ publishedAt: null }).sort({ publicationSequence: 1 }), blockedPartitions: await Failure.find({ status: 'BLOCKED' }) } });
  });
}
