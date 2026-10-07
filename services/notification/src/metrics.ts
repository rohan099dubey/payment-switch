import { collectDefaultMetrics, Counter, type Registry } from 'prom-client';
import type { ProcessorObserver } from './domain/processor';

export interface NotificationMetrics {
  /** `outcome`: delivered, dead_lettered, duplicate, invalid. */
  notifications: Counter<'outcome'>;
  /** `result`: ok, failed. One per webhook call. */
  webhookAttempts: Counter<'result'>;
}

/** ADR-026. */
export function createNotificationMetrics(registry: Registry): NotificationMetrics {
  collectDefaultMetrics({ register: registry });
  return {
    notifications: new Counter({
      name: 'notifications_total',
      help: 'transfer-events messages handled, by outcome',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    webhookAttempts: new Counter({
      name: 'webhook_attempts_total',
      help: 'Webhook calls, by result',
      labelNames: ['result'] as const,
      registers: [registry],
    }),
  };
}

export function processorObserver(metrics: NotificationMetrics): ProcessorObserver {
  return {
    handled: (result) => {
      metrics.notifications.inc({ outcome: result });
    },
    attempt: (ok) => {
      metrics.webhookAttempts.inc({ result: ok ? 'ok' : 'failed' });
    },
  };
}
