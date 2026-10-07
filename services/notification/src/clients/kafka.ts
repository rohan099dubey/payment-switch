import type { Logger } from '@switch/common';
import { Kafka, logLevel, Partitioners, type Consumer, type LogEntry, type Producer } from 'kafkajs';
import { DLQ_TOPIC, TRANSFER_EVENTS_TOPIC, type IncomingMessage } from '../domain/events';
import type { DeadLetterMessage, DeadLetterPort } from '../domain/processor';

/** Consumer group (section 19). */
export const CONSUMER_GROUP = 'notification';
const TOPIC_PARTITIONS = 3;
const REQUEST_TIMEOUT_MS = 10_000;

export function createKafka(brokers: string[], clientId: string, logger: Logger): Kafka {
  const log = logger.child({ subsystem: 'kafkajs' });
  return new Kafka({
    clientId,
    brokers,
    connectionTimeout: 3000,
    requestTimeout: REQUEST_TIMEOUT_MS,
    logLevel: logLevel.WARN,
    logCreator:
      () =>
      ({ namespace, level, log: entry }: LogEntry) => {
        const { message, ...extra } = entry;
        const fields = { namespace, ...extra };
        if (level <= logLevel.ERROR) log.error(fields, message);
        else log.warn(fields, message);
      },
  });
}

/**
 * Both topics exist before the consumer starts (ADR-026). The broker does not auto-create
 * topics (ADR-025), and the Orchestrator may not have created `transfer-events` yet.
 */
export async function ensureTopics(kafka: Kafka): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    // Only the missing ones: kafkajs logs an error for every topic that already exists.
    const existing = new Set(await admin.listTopics());
    const missing = [TRANSFER_EVENTS_TOPIC, DLQ_TOPIC].filter((topic) => !existing.has(topic));
    if (missing.length > 0) {
      await admin.createTopics({
        topics: missing.map((topic) => ({ topic, numPartitions: TOPIC_PARTITIONS, replicationFactor: 1 })),
        waitForLeaders: true,
      });
    }
  } finally {
    await admin.disconnect();
  }
}

/** Dead letters to `transfer-events.dlq`: idempotent producer, `acks=all`, keyed by transfer id. */
export class KafkaDeadLetters implements DeadLetterPort {
  private readonly producer: Producer;
  private connected = false;

  constructor(kafka: Kafka) {
    this.producer = kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
      allowAutoTopicCreation: false,
      createPartitioner: Partitioners.DefaultPartitioner,
    });
  }

  async publish(message: DeadLetterMessage): Promise<void> {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
    await this.producer.send({ topic: DLQ_TOPIC, acks: -1, timeout: REQUEST_TIMEOUT_MS, messages: [message] });
  }

  async close(): Promise<void> {
    if (this.connected) await this.producer.disconnect();
    this.connected = false;
  }
}

/**
 * Consumer group `notification` on `transfer-events`, from the beginning for a new group,
 * one message at a time per partition. The offset is committed after `handle` resolves;
 * if it throws, kafkajs retries and the message comes back (at-least-once).
 */
export async function startConsumer(
  kafka: Kafka,
  handle: (message: IncomingMessage) => Promise<unknown>,
  onJoined: () => void,
): Promise<Consumer> {
  const consumer = kafka.consumer({ groupId: CONSUMER_GROUP });
  consumer.on(consumer.events.GROUP_JOIN, onJoined);
  await consumer.connect();
  await consumer.subscribe({ topic: TRANSFER_EVENTS_TOPIC, fromBeginning: true });
  await consumer.run({
    partitionsConsumedConcurrently: TOPIC_PARTITIONS,
    eachMessage: async ({ message }) => {
      const headers: Record<string, string> = {};
      for (const [name, raw] of Object.entries(message.headers ?? {})) {
        if (raw !== undefined) headers[name] = raw.toString();
      }
      await handle({ key: message.key?.toString() ?? null, value: message.value?.toString() ?? null, headers });
    },
  });
  return consumer;
}
