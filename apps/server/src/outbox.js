import { connect, mongoose, Outbox } from './database.js';
import { kafka, initialize } from './kafka.js';
import { setTimeout as sleep } from 'node:timers/promises';
await connect(); await initialize();
const producer = kafka.producer(); await producer.connect();
let running = true;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { running = false; });
while (running) {
  const record = await Outbox.findOne({ publishedAt: null }).sort({ publicationSequence: 1 });
  if (!record) { await sleep(250); continue; }
  try {
    await producer.send({ topic: record.topic, acks: -1, messages: [{ key: record.partitionKey, value: JSON.stringify(record.envelope) }] });
    await Outbox.updateOne({ _id: record._id }, { $set: { publishedAt: new Date(), lastError: null } });
  } catch (error) {
    await Outbox.updateOne({ _id: record._id }, { $inc: { attempts: 1 }, $set: { lastError: error.message } });
    await sleep(1000);
  }
}
await producer.disconnect(); await mongoose.disconnect();
