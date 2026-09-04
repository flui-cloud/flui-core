import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';

/**
 * Selectable, so a sweep can find every paused workload in a cluster with one
 * request. Kubernetes cannot select on annotations, which is why the marker is
 * a label and the details beside it are annotations.
 */
export const PAUSED_LABEL = 'flui.cloud/paused-for-copy';
export const PAUSED_REPLICAS_ANNOTATION = 'flui.cloud/paused-replicas';
export const PAUSED_AT_ANNOTATION = 'flui.cloud/paused-at';

/**
 * How long a pause may outlive the thing that took it.
 *
 * The copy Job is killed by its own `activeDeadlineSeconds`, so a lease older
 * than that plus a margin belongs to a copy that is no longer running, whatever
 * the process that started it believes. Releasing it is always the right call.
 */
export const PAUSE_LEASE_TTL_MS = 45 * 60 * 1000;

export interface PausedWorkload {
  kind: 'Deployment' | 'StatefulSet';
  name: string;
  namespace: string;
  replicas: number;
}

/**
 * Stops the writers of a volume so it can be copied at rest, and guarantees
 * they come back.
 *
 * The guarantee is the whole point, and it is why the pause is not a
 * `try/finally` around the copy. A `finally` restores the workload when this
 * process lives long enough to run it; if the API is killed between the
 * scale-down and the scale-up, the application stays at zero replicas and
 * nothing anywhere remembers that it should not be. An application left down by
 * a backup is a far worse outcome than an inconsistent copy.
 *
 * So the lease is written onto the workload itself before it is scaled: it
 * survives this process dying, it is visible to anyone with kubectl, and it
 * sits on the object that needs restoring. Recovery is idempotent and keyed on
 * that annotation, and runs from four places — the copy's own path, a sweep at
 * boot, a periodic sweep for leases past their TTL, and the shutdown hook. Any
 * one of them is enough; the TTL is what bounds the outage when all the others
 * are gone.
 */
@Injectable()
export class VolumePauseLeaseService {
  private readonly logger = new Logger(VolumePauseLeaseService.name);

  constructor(private readonly k8s: KubernetesService) {}

  /**
   * Scales down every workload holding the volume, and waits for the pods to
   * actually be gone.
   *
   * Refuses rather than half-pausing: a writer this cannot stop makes the
   * whole exercise a lie, and the caller should be told before anything moves.
   */
  async acquire(
    kubeconfig: string,
    namespace: string,
    pvcName: string,
  ): Promise<PausedWorkload[]> {
    const pods = await this.k8s.findPodsMountingPvcDetailed(
      kubeconfig,
      namespace,
      pvcName,
    );
    const unreachable = pods.filter((p) => p.phase === 'Unknown');
    if (unreachable.length > 0) {
      throw new BadRequestException(
        `Cannot pause ${pvcName}: the node running ${unreachable
          .map((p) => p.name)
          .join(', ')} cannot be reached, so scaling to zero would not stop ` +
          'it writing. Wait for the node to recover, or take the copy with ' +
          '--allow-inconsistent.',
      );
    }

    const workloads = await this.k8s.findWorkloadsMountingPvc(
      kubeconfig,
      namespace,
      pvcName,
    );
    const scalablePods = new Set<string>();
    for (const workload of workloads) {
      for (const pod of pods) {
        if (pod.ownerRootName === workload.name) scalablePods.add(pod.name);
      }
    }
    // A pod held by a Job, a DaemonSet or no controller at all cannot be
    // scaled down, so pausing the Deployments around it would report a quiet
    // volume while that pod kept writing.
    const unstoppable = pods.filter((p) => !scalablePods.has(p.name));
    if (unstoppable.length > 0) {
      throw new BadRequestException(
        `Cannot pause ${pvcName}: ${unstoppable
          .map((p) => `${p.name} (${p.ownerRootKind ?? 'no controller'})`)
          .join(', ')} holds it and is not something Flui can scale down. ` +
          'Stop it yourself, or take the copy with --allow-inconsistent.',
      );
    }

    const paused: PausedWorkload[] = [];
    for (const workload of workloads) {
      if (workload.replicas === 0) continue;
      await this.k8s.annotateAndLabelWorkload(
        kubeconfig,
        workload.kind,
        namespace,
        workload.name,
        { [PAUSED_LABEL]: 'true' },
        {
          [PAUSED_REPLICAS_ANNOTATION]: String(workload.replicas),
          [PAUSED_AT_ANNOTATION]: new Date().toISOString(),
        },
      );
      await this.k8s.scaleWorkload(
        kubeconfig,
        workload.kind,
        namespace,
        workload.name,
        0,
      );
      paused.push({ ...workload, namespace });
    }

    await this.waitUntilNoPodsHold(kubeconfig, namespace, pvcName);
    this.logger.log(
      `[pause] ${namespace}/${pvcName}: paused ${paused
        .map((w) => `${w.kind}/${w.name}@${w.replicas}`)
        .join(', ')}`,
    );
    return paused;
  }

  /**
   * Puts back exactly what was taken away.
   *
   * Idempotent and keyed on the annotation, never on a remembered number: a
   * workload without the annotation is one nothing paused, and scaling it
   * would be inventing a replica count for someone else's object.
   */
  async release(
    kubeconfig: string,
    workloads: ReadonlyArray<PausedWorkload>,
  ): Promise<void> {
    for (const workload of workloads) {
      try {
        const live = await this.k8s.getResource(
          kubeconfig,
          workload.kind,
          workload.name,
          workload.namespace,
        );
        const recorded =
          live?.metadata?.annotations?.[PAUSED_REPLICAS_ANNOTATION];
        if (recorded === undefined) continue;
        const replicas = Number.parseInt(recorded, 10);
        if (Number.isFinite(replicas) && (live?.spec?.replicas ?? 0) === 0) {
          await this.k8s.scaleWorkload(
            kubeconfig,
            workload.kind,
            workload.namespace,
            workload.name,
            replicas,
          );
        }
        await this.k8s.annotateAndLabelWorkload(
          kubeconfig,
          workload.kind,
          workload.namespace,
          workload.name,
          { [PAUSED_LABEL]: null },
          {
            [PAUSED_REPLICAS_ANNOTATION]: null,
            [PAUSED_AT_ANNOTATION]: null,
          },
        );
        this.logger.log(
          `[pause] released ${workload.namespace}/${workload.kind}/${workload.name} → ${replicas} replica(s)`,
        );
      } catch (err: any) {
        // Keep going: one workload that cannot be restored must not strand the
        // others, and the sweep will try this one again.
        this.logger.error(
          `[pause] could not release ${workload.namespace}/${workload.kind}/${workload.name}: ${err?.message}`,
        );
      }
    }
  }

  /**
   * Finds every paused workload in a cluster and releases the expired ones.
   *
   * `force` is for shutdown and boot, where there is no copy left that could
   * still be using the pause — at boot because any copy this process started
   * died with the previous one, at shutdown because it is about to.
   */
  async sweep(kubeconfig: string, force = false): Promise<number> {
    let released = 0;
    for (const kind of ['Deployment', 'StatefulSet'] as const) {
      const found = await this.k8s
        .listResourcesByLabelEverywhere(
          kubeconfig,
          kind,
          `${PAUSED_LABEL}=true`,
        )
        .catch(() => [] as any[]);
      for (const workload of found) {
        const pausedAt = Date.parse(
          workload?.metadata?.annotations?.[PAUSED_AT_ANNOTATION] ?? '',
        );
        const expired =
          !Number.isFinite(pausedAt) ||
          Date.now() - pausedAt > PAUSE_LEASE_TTL_MS;
        if (!force && !expired) continue;
        await this.release(kubeconfig, [
          {
            kind,
            name: workload?.metadata?.name,
            namespace: workload?.metadata?.namespace,
            replicas: 0,
          },
        ]);
        released += 1;
      }
    }
    if (released > 0) {
      this.logger.warn(
        `[pause] swept ${released} workload(s) left paused by a copy that is no longer running`,
      );
    }
    return released;
  }

  private async waitUntilNoPodsHold(
    kubeconfig: string,
    namespace: string,
    pvcName: string,
  ): Promise<void> {
    // Terminating is not stopped. Postgres runs a checkpoint on SIGTERM and
    // writes throughout its grace period, so a copy that began at scale-to-0
    // would be a live copy with extra steps.
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      const holders = await this.k8s.findPodsMountingPvc(
        kubeconfig,
        namespace,
        pvcName,
      );
      if (holders.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error(
      `Timed out waiting for the pods holding ${namespace}/${pvcName} to stop`,
    );
  }
}
