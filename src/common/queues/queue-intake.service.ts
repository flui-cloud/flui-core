import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { withTimeout } from '../../modules/infrastructure/shared/utils/with-timeout.util';

// A queue whose Redis is unreachable cannot hand out jobs anyway; waiting on it
// would hold up the rest of shutdown.
const PAUSE_TIMEOUT_MS = 5_000;

interface PausableQueue {
  name: string;
  pause(isLocal?: boolean, doNotWaitActive?: boolean): Promise<void>;
}

export function isQueue(instance: unknown): instance is PausableQueue {
  const candidate = instance as Partial<PausableQueue> & {
    getJobCounts?: unknown;
  };
  return (
    typeof candidate?.pause === 'function' &&
    typeof candidate?.getJobCounts === 'function' &&
    typeof candidate?.name === 'string'
  );
}

/**
 * A copy being stopped keeps the jobs it is running, which is what its long
 * grace period is for, but takes no new ones: a job started on its way out runs
 * against connections that are closing and is lost with it. The queues are only
 * closed at the very end of shutdown, so they are paused here, in the first
 * hook Nest runs.
 */
@Injectable()
export class QueueIntakeService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueIntakeService.name);

  constructor(private readonly discovery: DiscoveryService) {}

  async onModuleDestroy(): Promise<void> {
    const queues = this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance as unknown)
      .filter(isQueue);
    const results = await Promise.all(
      queues.map((queue) =>
        withTimeout(
          queue.pause(true, true).then(() => true),
          PAUSE_TIMEOUT_MS,
        ),
      ),
    );
    const failed = results.filter((paused) => !paused).length;
    this.logger.log(
      `Stopped taking new jobs on ${queues.length - failed} queue(s)` +
        (failed ? `; ${failed} could not be paused` : ''),
    );
  }
}
