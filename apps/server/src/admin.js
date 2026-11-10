import { z } from 'zod';
import { randomBytes, scryptSync } from 'node:crypto';
import { User, Warehouse } from './database.js';
import { AppError } from './domain.js';
import { execute } from './commands.js';
export function adminRoutes(app) {
  app.get('/api/v1/warehouses', async (req, res) => res.json({ data: await Warehouse.find({ _id: { $in: req.user.warehouseIds } }) }));
  app.get('/api/v1/users', async (req, res) => {
    if (req.user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Admin required.');
    res.json({ data: await User.find({ warehouseIds: { $in: req.user.warehouseIds } }).select('email role warehouseIds').limit(100) });
  });
  app.post('/api/v1/users', async (req, res) => {
    if (req.user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Admin required.');
    const input = z.object({ email: z.string().email().toLowerCase(), password: z.string().min(16).max(128), role: z.enum(['admin', 'manager', 'operator', 'viewer']), warehouseIds: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).min(1).max(10) }).strict().parse(req.body);
    if (input.warehouseIds.some(id => !req.user.warehouseIds.some(allowed => String(allowed) === id))) throw new AppError(403, 'FORBIDDEN', 'Warehouse scope denied.');
    const salt = randomBytes(16).toString('hex');
    const passwordHash = `${salt}:${scryptSync(input.password, salt, 64).toString('hex')}`;
    const result = await execute(req.user, '/users', req.get('idempotency-key'), input, async session => {
      const [user] = await User.create([{ email: input.email, role: input.role, warehouseIds: input.warehouseIds, passwordHash }], { session });
      return { status: 201, body: { data: { id: user._id, email: user.email, role: user.role, warehouseIds: user.warehouseIds } } };
    });
    res.status(result.status).json(result.body);
  });
}
