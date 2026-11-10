// Add provenance without rewriting operational quantities. Recognize only the exact v1 seed.
import { connect, mongoose, Warehouse, Product, Demand, Observation, Balance } from './database.js';
import { dateAdd } from './forecast-contract.js';
await connect();
let recognized = 0, conservative = 0;
try {
  for (const warehouse of await Warehouse.find({})) {
    const seedDate = warehouse.createdAt.toISOString().slice(0, 10);
    const productIds = await Balance.find({ warehouseId: warehouse._id }).distinct('productId');
    for (const product of await Product.find({ _id: { $in: productIds } })) {
      if (await Observation.exists({ warehouseId: warehouse._id, productId: product._id })) continue;
      const rows = await Demand.find({ warehouseId: warehouse._id, productId: product._id, date: { $gte: dateAdd(seedDate, -120), $lt: seedDate } }).sort({ date: 1 });
      const index = /^DEMO-\d{3}$/.test(product.sku) ? Number(product.sku.slice(5)) - 1 : -1;
      const matches = warehouse.name === 'WarehouseOS Demo' && index >= 0 && index < 60 && rows.length === 120 && rows.every((row, i) => row.date === dateAdd(seedDate, i - 120) && row.requestedUnits === 3 + (index * 17 + (120 - i) * 7) % 12 && row.fulfilledUnits === row.requestedUnits);
      await mongoose.connection.transaction(async session => {
        if (matches) {
          for (const row of rows) await Demand.updateOne({ _id: row._id }, { $set: { syntheticSeedUnits: row.requestedUnits, provenance: 'synthetic-seed-v1' } }, { session });
        }
        await Observation.updateOne({ warehouseId: warehouse._id, productId: product._id }, { $setOnInsert: { startDate: matches ? dateAdd(seedDate, -120) : dateAdd(new Date().toISOString().slice(0, 10), 1), source: matches ? 'synthetic-seed-v1' : 'legacy-observation-started-at-migration' } }, { upsert: true, session });
      });
      if (matches) recognized++; else conservative++;
    }
  }
  console.log(JSON.stringify({ recognizedSeedSeries: recognized, conservativeObservationStarts: conservative, note: 'Legacy simulator demand cannot be reliably separated and remains unclassified.' }));
} finally { await mongoose.disconnect(); }
