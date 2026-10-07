/** Reads Kafka topic `transfer-events` from the host listener (ADR-025), for tests. */
import { randomUUID } from 'node:crypto';
import { Kafka, logLevel } from 'kafkajs';

export const KAFKA_HOST_BROKERS = (process.env.KAFKA_HOST_BROKERS ?? 'localhost:9094').split(',');
export const TRANSFER_EVENTS_TOPIC = 'transfer-events';
export const DLQ_TOPIC = 'transfer-events.dlq';

export interface ConsumedEvent {
  key: string;
  headers: Record<string, string>;
  /** The parsed JSON value, or null when the value is not a JSON object (e.g. a malformed message). */
  value: Record<string, unknown> | null;
  raw: string;
  partition: number;
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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
  return readTopic(TRANSFER_EVENTS_TOPIC, keys, timeoutMs);
}

/** `readTransferEvents` for any topic, e.g. `transfer-events.dlq` (ADR-026). */
export async function readTopic(
  topic: string,
  keys: ReadonlySet<string>,
  timeoutMs = 60_000,
): Promise<Map<string, ConsumedEvent[]>> {
  const kafka = new Kafka({ clientId: 'tests', brokers: KAFKA_HOST_BROKERS, logLevel: logLevel.NOTHING });
  const consumer = kafka.consumer({ groupId: `tests-${randomUUID()}` });
  const found = new Map<string, ConsumedEvent[]>();
  await consumer.connect();
  try {
    await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({
      eachMessage: ({ message, partition }) => {
        const key = message.key?.toString() ?? '';
        if (keys.has(key)) {
          const headers: Record<string, string> = {};
          for (const [name, raw] of Object.entries(message.headers ?? {})) {
            if (raw !== undefined) headers[name] = raw.toString();
          }
          // Never throw here: a throwing handler would stall the read (kafkajs retries it).
          const raw = message.value?.toString() ?? '';
          found.set(key, [...(found.get(key) ?? []), { key, headers, value: parseObject(raw), raw, partition }]);
        }
        return Promise.resolve();
      },
    });
    const until = Date.now() + timeoutMs;
    while (found.size < keys.size) {
      if (Date.now() > until) {
        const missing = [...keys].filter((k) => !found.has(k));
        throw new Error(`${missing.length} of ${keys.size} keys not in ${topic}: ${missing.join(', ')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return found;
  } finally {
    await consumer.disconnect();
  }
}

/** Produces raw messages, e.g. a redelivered copy or a malformed message (ADR-026 tests). */
export async function produceRaw(
  topic: string,
  messages: { key: string; value: string; headers: Record<string, string> }[],
): Promise<void> {
  const kafka = new Kafka({ clientId: 'tests', brokers: KAFKA_HOST_BROKERS, logLevel: logLevel.NOTHING });
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();
  try {
    await producer.send({ topic, acks: -1, messages });
  } finally {
    await producer.disconnect();
  }
}
