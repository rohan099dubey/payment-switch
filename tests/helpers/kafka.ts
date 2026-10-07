/** Reads Kafka topic `transfer-events` from the host listener (ADR-025), for tests. */
import { randomUUID } from 'node:crypto';
import { Kafka, logLevel } from 'kafkajs';

export const KAFKA_HOST_BROKERS = (process.env.KAFKA_HOST_BROKERS ?? 'localhost:9094').split(',');
export const TRANSFER_EVENTS_TOPIC = 'transfer-events';

export interface ConsumedEvent {
  key: string;
  headers: Record<string, string>;
  value: Record<string, unknown>;
  partition: number;
}

/**
 * Reads the topic from the beginning with a fresh consumer group until every wanted key
 * has arrived, or throws after `timeoutMs`. Returns **every** delivery per key, so a
 * test can see duplicates (delivery is at-least-once).
 */
export async function readTransferEvents(
  keys: ReadonlySet<string>,
  timeoutMs = 60_000,
): Promise<Map<string, ConsumedEvent[]>> {
  const kafka = new Kafka({ clientId: 'tests', brokers: KAFKA_HOST_BROKERS, logLevel: logLevel.NOTHING });
  const consumer = kafka.consumer({ groupId: `tests-${randomUUID()}` });
  const found = new Map<string, ConsumedEvent[]>();
  await consumer.connect();
  try {
    await consumer.subscribe({ topic: TRANSFER_EVENTS_TOPIC, fromBeginning: true });
    await consumer.run({
      eachMessage: ({ message, partition }) => {
        const key = message.key?.toString() ?? '';
        if (keys.has(key)) {
          const headers: Record<string, string> = {};
          for (const [name, raw] of Object.entries(message.headers ?? {})) {
            if (raw !== undefined) headers[name] = raw.toString();
          }
          const value = JSON.parse(message.value?.toString() ?? 'null') as Record<string, unknown>;
          found.set(key, [...(found.get(key) ?? []), { key, headers, value, partition }]);
        }
        return Promise.resolve();
      },
    });
    const until = Date.now() + timeoutMs;
    while (found.size < keys.size) {
      if (Date.now() > until) {
        const missing = [...keys].filter((k) => !found.has(k));
        throw new Error(
          `${missing.length} of ${keys.size} keys not in ${TRANSFER_EVENTS_TOPIC}: ${missing.join(', ')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return found;
  } finally {
    await consumer.disconnect();
  }
}
