import { randomBytes, scryptSync } from 'node:crypto';
import { connect, mongoose, Warehouse, User, Product, Balance, Bin, Demand, Observation } from './database.js';
if (!process.env.SEED_PASSWORD || process.env.SEED_PASSWORD.length < 16) throw new Error('Set SEED_PASSWORD to at least 16 characters');
await connect();
try {
  await mongoose.connection.transaction(async session => {
    if (await Warehouse.exists({}).session(session)) throw new Error('Seed requires an empty warehouse database');
    const nodes = Array.from({ length: 21 }, (_, i) => ({ id: `aisle-${i}`, position: { x: i * 3, y: 0, z: 2 } }));
    const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id, distance: 3 }));
    const [warehouse] = await Warehouse.create([{ name: 'WarehouseOS Demo', timezone: 'UTC', dimensions: { x: 66, y: 8, z: 20 }, layoutVersion: 1, aisleGraph: { nodes, edges, startNodeId: 'aisle-0' } }], { session });
    for (const role of ['admin', 'manager', 'operator', 'operator2', 'operator3', 'viewer']) {
      const salt = randomBytes(16).toString('hex');
      await User.create([{ email: `${role}@warehouse.test`, role: role.startsWith('operator') ? 'operator' : role, warehouseIds: [warehouse._id], passwordHash: `${salt}:${scryptSync(process.env.SEED_PASSWORD, salt, 64).toString('hex')}` }], { session });
    }
    const bins = [];
    for (let i = 0; i < 60; i++) {
      const rack = Math.floor(i / 3);
      const [bin] = await Bin.create([{ warehouseId: warehouse._id, rackCode: `Z${Math.floor(rack / 5) + 1}-R${rack + 1}`, binCode: `B${i + 1}`, position: { x: (rack + 1) * 3, y: i % 3 * 2, z: 4 }, dimensions: { x: 2, y: 1.5, z: 2 }, aisleNodeId: `aisle-${rack + 1}` }], { session });
      bins.push(bin);
    }
    for (let i = 0; i < 60; i++) {
      const [product] = await Product.create([{ sku: `DEMO-${String(i + 1).padStart(3, '0')}`, name: `Product ${i + 1}`, category: `Category ${i % 4 + 1}`, active: true, reorderPoint: 20, leadTimeDays: 7 }], { session });
      await Balance.create([{ warehouseId: warehouse._id, productId: product._id, binId: bins[i]._id, onHand: 100, reserved: 0, version: 1 }], { session });
      await Observation.create([{ warehouseId: warehouse._id, productId: product._id, startDate: new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10), source: 'synthetic-seed-v1' }], { session });
      for (let day = 120; day > 0; day--) {
        const date = new Date(Date.now() - day * 86400000).toISOString().slice(0, 10);
        const units = 3 + (i * 17 + day * 7) % 12;
        await Demand.create([{ warehouseId: warehouse._id, productId: product._id, date, requestedUnits: units, fulfilledUnits: units, syntheticSeedUnits: units, provenance: 'synthetic-seed-v1' }], { session });
      }
    }
    console.log(JSON.stringify({ warehouseId: warehouse._id, syntheticHistoryDays: 120 }));
  });
} finally { await mongoose.disconnect(); }
