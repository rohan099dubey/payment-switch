import type { Logger } from '@switch/common';
import { Kafka, logLevel, Partitioners, type LogEntry, type Producer } from 'kafkajs';
import type { EventMessage } from '../domain/outboxEvents';
import type { EventPublisher } from '../outbox/relay';

export interface KafkaPublisherOptions {
  brokers: string[];
  clientId: string;
  topic: string;
  /** Created at startup if missing (ADR-025); the broker does not auto-create topics. */
  partitions: number;
  logger: Logger;
}

/** Bounds on how long a send may hold the relay's transaction open (ADR-025). */
const CONNECTION_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY = { retries: 3, initialRetryTime: 200, maxRetryTime: 2000 };

/**
 * The relay's Kafka side (section 19): an idempotent producer with `acks=all`, keyed by
 * transfer id. A failed send drops the connection so the next batch starts clean; the
 * rows it carried stay unpublished in the outbox.
 */
export class KafkaPublisher implements EventPublisher {
  private readonly kafka: Kafka;
  private producer: Producer | undefined;
  private topicReady = false;

  constructor(private readonly options: KafkaPublisherOptions) {
    const log = options.logger.child({ subsystem: 'kafkajs' });
    this.kafka = new Kafka({
      clientId: options.clientId,
      brokers: options.brokers,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      retry: RETRY,
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

  async ensureReady(): Promise<void> {
    if (!this.topicReady) await this.createTopic();
    if (this.producer === undefined) {
      // DefaultPartitioner is murmur2, as the Java client uses: a transfer id lands on the
      // same partition whichever client produced it. kafkajs warns that bounded retries
      // "may invalidate EoS": expected (ADR-025), because a failed send drops this producer
      // and the outbox retries the batch, so delivery stays at-least-once.
      const producer = this.kafka.producer({
        idempotent: true,
        maxInFlightRequests: 1,
        allowAutoTopicCreation: false,
        createPartitioner: Partitioners.DefaultPartitioner,
      });
      await producer.connect();
      this.producer = producer;
    }
  }

  async publish(messages: EventMessage[]): Promise<void> {
    const producer = this.producer;
    if (producer === undefined) throw new Error('publish called before ensureReady');
    try {
      await producer.send({ topic: this.options.topic, acks: -1, timeout: REQUEST_TIMEOUT_MS, messages });
    } catch (err) {
      this.producer = undefined;
      await producer.disconnect().catch(() => undefined);
      throw err;
    }
  }

  async close(): Promise<void> {
    const producer = this.producer;
    this.producer = undefined;
    if (producer !== undefined) await producer.disconnect();
  }

  private async createTopic(): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      // Only when missing: kafkajs logs an error for a topic that already exists. Several
      // instances may still race to create it; createTopics then resolves false, which is fine.
      if (!(await admin.listTopics()).includes(this.options.topic)) {
        await admin.createTopics({
          topics: [{ topic: this.options.topic, numPartitions: this.options.partitions, replicationFactor: 1 }],
          waitForLeaders: true,
        });
      }
      this.topicReady = true;
    } finally {
      await admin.disconnect();
    }
  }
}
