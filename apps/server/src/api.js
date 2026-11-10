import { mlRoutes } from './ml-routes.js';
import { context } from './context.js';
import { adminRoutes } from './admin.js';
import { routes } from './routes.js';
import { rateLimit } from 'express-rate-limit';
import pino from 'pino';
import express from 'express';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { connect, mongoose, User, Session, Order } from './database.js';
import { execute, reserve } from './commands.js';
import { AppError } from './domain.js';
if (!process.env.APP_ORIGIN) throw new Error('APP_ORIGIN is required');
const app = express();
app.disable('x-powered-by');
const logger = pino();
app.use((req, res, next) => { req.requestId = randomBytes(16).toString('hex'); res.set('X-Request-Id', req.requestId); const start = Date.now(); res.on('finish', () => logger.info({ requestId: req.requestId, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - start })); context.run({ requestId: req.requestId }, next); });
app.use('/api/v1/auth/login', rateLimit({ windowMs: 60000, limit: 10 }));
app.use((req, res, next) => {
  if (req.get('origin') === process.env.APP_ORIGIN) { res.set('Access-Control-Allow-Origin', process.env.APP_ORIGIN); res.set('Access-Control-Allow-Credentials', 'true'); res.vary('Origin'); }
  if (req.method === 'OPTIONS') { res.set('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Idempotency-Key'); res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); return res.sendStatus(204); }
  next();
});
app.use(express.json({ limit: '64kb' }));
app.get('/api/v1/health/live', (req, res) => res.json({ data: { live: true } }));
app.get('/api/v1/health/ready', (req, res) => res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({ data: { database: mongoose.connection.readyState === 1 } }));
app.post('/api/v1/auth/login', async (req, res) => {
  if (req.get('origin') !== process.env.APP_ORIGIN) throw new AppError(403, 'ORIGIN_DENIED', 'Origin is not allowed.');
  const input = z.object({ email: z.string().email(), password: z.string().min(1).max(256) }).strict().parse(req.body);
  const user = await User.findOne({ email: input.email.toLowerCase() });
  const [salt, hash] = (user?.passwordHash || 'dummy:' + '00'.repeat(64)).split(':');
  if (!timingSafeEqual(scryptSync(input.password, salt, 64), Buffer.from(hash, 'hex')) || !user) throw new AppError(401, 'INVALID_LOGIN', 'Invalid credentials.');
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  await Session.create({ userId: user._id, tokenHash: createHash('sha256').update(token).digest('hex'), csrf, expiresAt: new Date(Date.now() + 8 * 3600000) });
  res.cookie('session', token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 3600000 });
  res.json({ data: { csrf } });
});
app.use('/api/v1', async (req, res, next) => {
  const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('session='))?.slice(8) || '';
  const session = await Session.findOne({ tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: { $gt: new Date() } });
  if (!session) throw new AppError(401, 'UNAUTHENTICATED', 'Login is required.');
  req.user = await User.findById(session.userId);
  if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', 'User is unavailable.');
  if (req.method !== 'GET' && (req.get('origin') !== process.env.APP_ORIGIN || req.get('x-csrf-token') !== session.csrf)) throw new AppError(403, 'CSRF_DENIED', 'Invalid origin or CSRF token.');
  req.session = session;
  next();
});
app.get('/api/v1/auth/me', (req, res) => res.json({ data: { id: req.user._id, role: req.user.role, warehouseIds: req.user.warehouseIds, csrf: req.session.csrf } }));
app.post('/api/v1/auth/logout', async (req, res) => { await req.session.deleteOne(); res.clearCookie('session'); res.json({ data: null }); });
const objectId = z.string().regex(/^[a-f0-9]{24}$/i).transform(v => v.toLowerCase());
const orderSchema = z.object({ warehouseId: objectId, items: z.array(z.object({ productId: objectId, quantity: z.number().int().positive().max(10000) }).strict()).min(1).max(100) }).strict().refine(v => new Set(v.items.map(i => i.productId)).size === v.items.length, 'Duplicate products are not allowed.');
app.post('/api/v1/orders', async (req, res) => {
  const input = orderSchema.parse(req.body);
  if (!['admin', 'manager'].includes(req.user.role) || !req.user.warehouseIds.some(id => String(id) === input.warehouseId)) throw new AppError(403, 'FORBIDDEN', 'Warehouse operation is not allowed.');
  const result = await execute(req.user, '/orders', req.get('idempotency-key'), input, session => reserve(req.user, input, session));
  res.status(result.status).json(result.body);
});
routes(app);
adminRoutes(app);
mlRoutes(app);
app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: req.requestId } }));
app.use((error, req, res, next) => {
  const status = error instanceof z.ZodError ? 422 : error.code === 11000 ? 409 : error.status || 500;
  res.status(status).json({ error: { requestId: req.requestId, code: error.code || 'VALIDATION_OR_SERVER_ERROR', message: status === 500 ? 'Unexpected server error.' : error.message } });
});
await connect();
const server = app.listen(Number(process.env.PORT || 4000));


const { realtime } = await import('./realtime.js');
const shutdownRealtime = await realtime(server);

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await shutdownRealtime();
  server.close(async () => { await mongoose.disconnect(); process.exit(0); });
});
