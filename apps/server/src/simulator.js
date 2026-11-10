import { connect, mongoose, Run, User, Product, Task, Order, Balance } from './database.js';
import { execute, reserve } from './commands.js';
import { claim, pick, transition, stock } from './operations.js';
import { setTimeout as sleep } from 'node:timers/promises';
await connect();
let running = true;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { running = false; });
while (running) {
  for (const run of await Run.find({ status: 'RUNNING' })) {
    if (Date.now() - run.createdAt.getTime() >= run.durationSeconds * 1000) { run.status = 'COMPLETED'; await run.save(); continue; }
    const actor = await User.findById(run.actorId);
    const stockedProductIds = await Balance.find({ warehouseId: run.warehouseId }).distinct('productId');
    const products = await Product.find({ active: true, _id: { $in: stockedProductIds } }).sort({ sku: 1 }).limit(run.scenario === 'surge' ? 3 : 60);
    try {
      if (!products.length) throw new Error('No stocked products in selected warehouse');
      for (let i = 0; i < run.rate; i++) {
        const sequence = run.tick * run.rate + i;
        const product = products[((run.seed + sequence * 1664525) >>> 0) % products.length];
        const input = { warehouseId: String(run.warehouseId), items: [{ productId: String(product._id), quantity: ['surge', 'low-stock'].includes(run.scenario) ? 15 : 2 }], simulationRunId: run._id };
        const result = await execute(actor, '/simulation/order', `${run._id}:${sequence}`, input, s => reserve(actor, input, s));
        if (result.status === 201 && run.scenario !== 'backlog') {
          let task = await Task.findOne({ orderId: result.body.data._id });
          await execute(actor, '/simulation/claim', String(task._id), {}, s => claim(actor, task._id, { expectedVersion: task.version }, s));
          task = await Task.findById(task._id);
          for (const allocation of task.allocations) {
            if (allocation.confirmed === allocation.quantity) continue;
            await execute(actor, '/simulation/pick', `${task._id}:${allocation.balanceId}`, {}, s => pick(actor, task._id, { expectedVersion: task.version, balanceId: String(allocation.balanceId), quantity: allocation.quantity - allocation.confirmed }, s));
            task = await Task.findById(task._id);
          }
          for (const action of ['packing', 'dispatches']) {
            const order = await Order.findById(task.orderId);
            await execute(actor, `/simulation/${action}`, String(order._id), {}, s => transition(actor, order._id, action, { expectedVersion: order.version }, s));
          }
          if (run.scenario === 'normal') for (const allocation of task.allocations) {
            const receipt = { warehouseId: String(run.warehouseId), productId: String(allocation.productId), binId: String(allocation.binId), quantity: allocation.quantity, reason: `Simulation ${run._id}` };
            await execute(actor, '/simulation/receipt', `${task._id}:${allocation.balanceId}`, receipt, s => stock(actor, receipt, s, true));
          }
        }
      }
      await Run.updateOne({ _id: run._id, status: 'RUNNING' }, { $inc: { tick: 1 } });
    } catch (error) { await Run.updateOne({ _id: run._id }, { $set: { status: 'FAILED', error: error.message } }); }
  }
  await sleep(1000);
}
await mongoose.disconnect();
