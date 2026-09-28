import { Queue } from 'bull';

export const PLATFORM_UPDATE_QUEUE = 'platform-update';
export const PLATFORM_UPDATE_JOB = 'run-platform-update';
export const PLATFORM_UPGRADE_JOB = 'run-platform-upgrade';

export interface PlatformUpdateJobData {
  operationId: string;
}

/**
 * One job per operation at a time: the id dedupes a continuation queued by two
 * pods, and removal on finish lets a later resume queue it again.
 */
export async function enqueueUpgrade(
  queue: Queue<PlatformUpdateJobData>,
  operationId: string,
): Promise<void> {
  await queue.add(
    PLATFORM_UPGRADE_JOB,
    { operationId },
    {
      attempts: 1,
      jobId: `platform-upgrade:${operationId}`,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}
