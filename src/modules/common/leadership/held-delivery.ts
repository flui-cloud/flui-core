import { Logger } from '@nestjs/common';
import { Job, JobOptions } from 'bull';

export const HELD_RETRY_DELAY_MS = 60_000;
export const HELD_RETRY_LIMIT = 60;

const KEPT_OPTIONS: (keyof JobOptions)[] = [
  'attempts',
  'backoff',
  'removeOnComplete',
  'removeOnFail',
  'timeout',
];

export interface HeldRetryData {
  heldRetries?: number;
}

/**
 * Queues the same job again a minute later, for a delivery whose lock another
 * worker still holds: that worker may lose its job to Bull or die mid-way, and
 * nothing else would pick the work up. Gives up after an hour of held tries.
 */
export async function retryHeldDelivery<T extends HeldRetryData>(
  job: Job<T>,
  logger: Logger,
  label: string,
): Promise<void> {
  const heldRetries = (job.data.heldRetries ?? 0) + 1;
  if (heldRetries > HELD_RETRY_LIMIT) {
    logger.error(
      `${label} still held by another worker after ${HELD_RETRY_LIMIT} retries — giving up`,
    );
    return;
  }
  const kept = Object.fromEntries(
    KEPT_OPTIONS.filter((k) => job.opts?.[k] !== undefined).map((k) => [
      k,
      job.opts[k],
    ]),
  );
  const baseId = String(job.id).split(':held:')[0];
  await job.queue.add(
    job.name,
    { ...job.data, heldRetries },
    {
      ...kept,
      delay: HELD_RETRY_DELAY_MS,
      jobId: `${baseId}:held:${Date.now()}`,
    },
  );
  logger.warn(
    `${label} delivered again while another worker still holds it — retrying in ${HELD_RETRY_DELAY_MS / 1000}s (${heldRetries}/${HELD_RETRY_LIMIT})`,
  );
}
