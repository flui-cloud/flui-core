import { Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { BACKUP_DIR, ManifestMasterService } from './manifest-master.service';
import {
  documentsOf,
  WorkloadRef,
  workloadsOf,
} from '../utils/manifest-documents.util';
import { rolloutOf, workloadLabel } from '../utils/workload-rollout.util';

const POLL_MS = 5_000;

export interface RolloutWait {
  timeoutMs: number;
  /** Ready before this long may only mean K3s has not applied the file yet. */
  settleMs: number;
}

export interface WrittenPlan {
  kubeconfig: string;
  node: string;
  planId: string;
  contents: ReadonlyMap<string, string>;
}

export class RolloutFailedError extends Error {}

function workloadsIn(content: string | undefined): WorkloadRef[] {
  try {
    return workloadsOf(documentsOf(content ?? ''));
  } catch {
    return [];
  }
}

/**
 * Waits for the workloads of freshly written manifests to roll out, reading the
 * cluster only: the workload that fails to come back may be the database the
 * API itself runs on. When they do not, the previous files go back and the
 * refresh fails with what did not start.
 */
export class ManifestRolloutGuard {
  private readonly logger = new Logger(ManifestRolloutGuard.name);
  now: () => number = () => Date.now();
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly kubernetesService: KubernetesService,
    private readonly master: ManifestMasterService,
  ) {}

  async await(
    plan: WrittenPlan,
    wrote: string[],
    wait: RolloutWait,
  ): Promise<void> {
    const workloads = wrote.flatMap((name) =>
      workloadsIn(plan.contents.get(name)),
    );
    if (workloads.length === 0) return;

    const start = this.now();
    for (;;) {
      await this.sleep(POLL_MS);
      const pending = (await this.states(plan.kubeconfig, workloads)).filter(
        (s) => !s.ready,
      );
      const elapsed = this.now() - start;
      if (pending.length === 0 && elapsed >= wait.settleMs) return;
      if (elapsed < wait.timeoutMs) continue;

      const stuck = pending
        .map((s) => `${workloadLabel(s.workload)} (${s.detail})`)
        .join(', ');
      const restored = await this.master
        .restore(plan.kubeconfig, plan.node, plan.planId, wrote)
        .then((lines) => `put back: ${lines.join(', ')}`)
        .catch(
          (error: Error) =>
            `not put back (${error.message}); the previous files are in ${BACKUP_DIR}/${plan.planId}`,
        );
      this.logger.error(
        `Refresh ${plan.planId}: ${stuck} did not roll out; files ${restored}`,
      );
      throw new RolloutFailedError(
        `${stuck} did not come back within ${Math.round(wait.timeoutMs / 60_000)} minutes after the manifests were written; the files were ${restored}.`,
      );
    }
  }

  private states(kubeconfig: string, workloads: WorkloadRef[]) {
    return Promise.all(
      workloads.map(async (workload) => ({
        workload,
        ...rolloutOf(
          workload.kind,
          await this.kubernetesService
            .readObject(
              kubeconfig,
              'apps/v1',
              workload.kind,
              workload.name,
              workload.namespace,
            )
            .catch(() => null),
        ),
      })),
    );
  }
}
