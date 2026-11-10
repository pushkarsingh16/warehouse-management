import { Server } from 'socket.io';
import { createHash } from 'node:crypto';
import { Session, User } from './database.js';
import { kafka, initialize } from './kafka.js';
export async function realtime(server) {
  const io = new Server(server, { cors: { origin: process.env.APP_ORIGIN, credentials: true } });
  io.use(async (socket, next) => {
    try {
      if (socket.handshake.headers.origin !== process.env.APP_ORIGIN) throw new Error('Unauthorized origin');
      const token = (socket.handshake.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('session='))?.slice(8) || '';
      const session = await Session.findOne({ tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: { $gt: new Date() } });
      if (!session) throw new Error('Unauthenticated');
      const user = await User.findById(session.userId);
      if (!user) throw new Error('Unauthenticated');
      socket.data.user = user; socket.data.sessionId = session._id;
      next();
    } catch (error) { next(error); }
  });
  io.on('connection', socket => { for (const id of socket.data.user.warehouseIds) socket.join(String(id)); });
  const consumer = kafka.consumer({ groupId: 'realtime' });
  async function start() {
    await initialize();
    await consumer.connect();
    await consumer.subscribe({ topics: ['inventory', 'orders', 'pick-tasks', 'alerts', 'analytics', 'forecasts'].map(t => `warehouse.${t}.v1`), fromBeginning: false });
    await consumer.run({ eachMessage: async ({ topic, message }) => {
      let event;
      try { event = JSON.parse(message.value.toString()); } catch { return; }
      const entity = topic.split('.')[1];
      const sockets = await io.in(String(event.warehouseId)).fetchSockets();
      for (const socket of sockets) {
        if (!await Session.exists({ _id: socket.data.sessionId, expiresAt: { $gt: new Date() } })) { socket.disconnect(); continue; }
        if (entity === 'pick-tasks' && socket.data.user.role === 'operator' && event.payload.status !== 'OPEN' && String(event.payload.assignedTo) !== String(socket.data.user._id)) continue;
        socket.emit(`${entity === 'orders' ? 'order' : entity === 'pick-tasks' ? 'pick-task' : entity === 'alerts' ? 'alert' : entity === 'forecasts' ? 'forecast' : entity}.updated`, { id: event.aggregateId, version: event.aggregateVersion });
      }
    } });
  }
  let closing = false;
  async function retryStart() {
    while (!closing) {
      try { await start(); return; } catch (error) { console.error('Realtime Kafka connection failed:', error.message); await new Promise(resolve => setTimeout(resolve, 2000)); }
    }
  }
  retryStart();
  return async () => { closing = true; io.disconnectSockets(true); await consumer.disconnect(); io.close(); };
}
