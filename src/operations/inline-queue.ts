import type { Env } from '../env';
import { consumeNotifications } from './queue';

/**
 * A Queue stand-in for sites that have no Cloudflare Queue of their own (every site provisioned by the control plane).
 * send() hands the message to the normal consumer inside the request or cron that sent it, using waitUntil.
 *
 * Nothing is lost by running inline: every notification is a durable row in D1 first. A failed delivery is rescheduled in
 * that row (markRetryOrDead), and the five minute cron (recoverNotificationJobs) sends whatever is due again.
 * A real NOTIFICATIONS_QUEUE binding, when present, is always used unchanged.
 */
export function withInlineQueue(env: Env, ctx: ExecutionContext): Env {
  if (env.NOTIFICATIONS_QUEUE) return env;
  const inline = { ...env } as Env;
  const deliver = (body: unknown): void => {
    const message = { id: crypto.randomUUID(), timestamp: new Date(), body, attempts: 1, ack: () => undefined, retry: () => undefined };
    const batch = { queue: 'inline', messages: [message], ackAll: () => undefined, retryAll: () => undefined };
    ctx.waitUntil(
      consumeNotifications(batch as unknown as MessageBatch<unknown>, inline).catch((error: unknown) => {
        console.error('inline_queue_failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
      }),
    );
  };
  inline.NOTIFICATIONS_QUEUE = {
    send: async (body: unknown) => deliver(body),
    sendBatch: async (items: Iterable<{ body: unknown }>) => {
      for (const item of items) deliver(item.body);
    },
  } as unknown as Env['NOTIFICATIONS_QUEUE'];
  return inline;
}
