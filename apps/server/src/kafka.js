import { Kafka } from 'kafkajs';
export const topics = ['inventory', 'orders', 'pick-tasks', 'demand', 'alerts', 'forecasts', 'analytics', 'dead-letter'].map(name => `warehouse.${name}.v1`);
export const kafka = new Kafka({ clientId: 'warehouse-os', brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','), retry: { retries: 5 } });
export async function initialize() {
  const admin = kafka.admin(); await admin.connect();
  try { await admin.createTopics({ topics: topics.map(topic => ({ topic, numPartitions: 3, replicationFactor: 1 })) }); }
  finally { await admin.disconnect(); }
}
