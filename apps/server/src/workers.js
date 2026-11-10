import { connect, mongoose, Failure } from './database.js';
import { kafka, initialize } from './kafka.js';
import { project } from './projections.js';
import { setTimeout as sleep } from 'node:timers/promises';
await connect(); await initialize();
const producer = kafka.producer(); await producer.connect();
const consumers = [];
for (const [consumerName, topics] of Object.entries({ analytics: ['orders'], alerts: ['inventory'], 'demand-aggregation': ['demand', 'orders'] })) {
  const consumer = kafka.consumer({ groupId: consumerName }); consumers.push(consumer);
  await consumer.connect(); await consumer.subscribe({ topics: topics.map(t => `warehouse.${t}.v1`), fromBeginning: true });
  await consumer.run({ partitionsConsumedConcurrently: 3, autoCommit: false, eachBatchAutoResolve: false, eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
    for (const message of batch.messages) {
      if (!isRunning() || isStale()) break;
      const identity = { consumerName, topic: batch.topic, partition: batch.partition };
      while (isRunning() && await Failure.exists({ ...identity, status: 'BLOCKED' })) { await heartbeat(); await sleep(500); }
      let failure;
      let parsed;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { parsed = JSON.parse(message.value.toString()); await project(consumerName, parsed); failure = null; break; }
        catch (error) { failure = error; await heartbeat(); await sleep(250 * (attempt + 1)); }
      }
      if (failure) {
        const record = { ...identity, offset: message.offset, event: parsed || message.value.toString(), attempts: 3, error: failure.message, status: 'BLOCKED' };
        await producer.send({ topic: 'warehouse.dead-letter.v1', messages: [{ key: `${consumerName}:${batch.partition}`, value: JSON.stringify(record) }] });
        await Failure.updateOne(identity, { $set: record }, { upsert: true });
        consumer.seek({ topic: batch.topic, partition: batch.partition, offset: message.offset });
        return;
      }
      resolveOffset(message.offset);
      await consumer.commitOffsets([{ topic: batch.topic, partition: batch.partition, offset: (BigInt(message.offset) + 1n).toString() }]);
      await heartbeat();
    }
  } });
}
async function shutdown() { for (const c of consumers) await c.disconnect(); await producer.disconnect(); await mongoose.disconnect(); process.exit(0); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
