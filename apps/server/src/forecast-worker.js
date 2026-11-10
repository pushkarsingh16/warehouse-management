import { connect, mongoose, Warehouse, ForecastRun } from './database.js';
import { claimRun, createForecastRun, processRun } from './forecasts.js';
import { yesterday } from './forecast-contract.js';
await connect();
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; });
while (!stopping) {
  try {
    for (const warehouse of await Warehouse.find({})) {
      const last = await ForecastRun.findOne({ warehouseId: warehouse._id, throughDate: yesterday() }).sort({ createdAt: -1 });
      if (!last && !await ForecastRun.exists({ warehouseId: warehouse._id, active: true })) {
        try { await mongoose.connection.transaction(session => createForecastRun(warehouse._id, undefined, session)); } catch (error) { if (error.code !== 11000 && error.code !== 'FORECAST_RUN_ACTIVE') throw error; }
      }
    }
    const run = await claimRun();
    if (run) await processRun(run);
  } catch (error) { console.error(JSON.stringify({ component: 'forecast-worker', error: error.code || error.name })); }
  if (!stopping) await new Promise(resolve => setTimeout(resolve, 5000));
}
await mongoose.disconnect();
