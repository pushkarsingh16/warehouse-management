import { connect, mongoose, Failure } from './database.js';
await connect();
const [consumerName, topic, partition] = process.argv.slice(2);
if (!consumerName || !topic || !/^\d+$/.test(partition || '')) throw new Error('Usage: replay.js consumerName topic partition');
const result = await Failure.updateOne({ consumerName, topic, partition: Number(partition), status: 'BLOCKED' }, { $set: { status: 'RETRY' } });
console.log({ released: result.modifiedCount });
await mongoose.disconnect();
