import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';

const PVC = { apiVersion: 'v1', kind: 'PersistentVolumeClaim' } as const;
const PV = { apiVersion: 'v1', kind: 'PersistentVolume' } as const;
const STS = { apiVersion: 'apps/v1', kind: 'StatefulSet' } as const;
export const PREVIOUS_VOLUME_LABEL = 'flui.cloud/previous-volume';

const POLL_MS = 2_000;
const WAIT_MS = 3 * 60 * 1000;

export interface StatefulSetSwapInput {
  kubeconfig: string;
  namespace: string;
  statefulSet: string;
  /** The volume claim template's name — the application's volume name. */
  volumeName: string;
  /** The restored claim whose volume the database is to use. */
  restoredClaim: string;
  appId: string;
  now?: Date;
}

export interface StatefulSetSwapResult {
  /** The claim the database uses — its name never changes. */
  claim: string;
  /** Where the data it used before is kept, until someone deletes it. */
  previousClaim: string;
}

/**
 * A StatefulSet cannot be pointed at another claim: its claims are named after
 * the template and the ordinal, and the template is immutable. So the swap
 * moves the volumes instead of the pointer. The restored volume is bound to the
 * claim the database already uses, and the volume it used until now is kept
 * under a claim of its own, labelled as the previous one — nothing is copied
 * and nothing is lost if a step fails half way.
 */
@Injectable()
export class StatefulSetVolumeSwapService {
  private readonly logger = new Logger(StatefulSetVolumeSwapService.name);

  constructor(private readonly k8s: KubernetesService) {}

  async swap(input: StatefulSetSwapInput): Promise<StatefulSetSwapResult> {
    const { kubeconfig, namespace, statefulSet } = input;
    const sts = await this.read(kubeconfig, STS, statefulSet, namespace);
    if (!sts) {
      throw new BadRequestException(`${statefulSet} does not exist`);
    }
    const templates: any[] = sts.spec?.volumeClaimTemplates ?? [];
    if (!templates.some((t) => t?.metadata?.name === input.volumeName)) {
      const quoted = (t: any) => `"${t?.metadata?.name}"`;
      const existing = templates.map(quoted).join(', ') || 'none';
      throw new BadRequestException(
        `The database has no volume named "${input.volumeName}"; it has ${existing}.`,
      );
    }
    const replicas: number = sts.spec?.replicas ?? 1;
    if (replicas > 1) {
      throw new BadRequestException(
        'A copy can replace the data of a database with one instance only; this one runs several.',
      );
    }

    const claim = `${input.volumeName}-${statefulSet}-0`;
    const current = await this.read(kubeconfig, PVC, claim, namespace);
    const restored = await this.read(
      kubeconfig,
      PVC,
      input.restoredClaim,
      namespace,
    );
    if (!current?.spec?.volumeName) {
      throw new BadRequestException(
        `The database's volume ${claim} is not bound`,
      );
    }
    if (!restored?.spec?.volumeName || restored.status?.phase !== 'Bound') {
      throw new BadRequestException(
        `The restored volume ${input.restoredClaim} is not ready`,
      );
    }
    const currentPv = current.spec.volumeName as string;
    const restoredPv = restored.spec.volumeName as string;
    const reclaim = {
      [currentPv]: (await this.read(kubeconfig, PV, currentPv))?.spec
        ?.persistentVolumeReclaimPolicy,
      [restoredPv]: (await this.read(kubeconfig, PV, restoredPv))?.spec
        ?.persistentVolumeReclaimPolicy,
    };

    const stamp = (input.now ?? new Date())
      .toISOString()
      .replaceAll(/[-:T]/g, '')
      .slice(0, 14);
    const previousClaim = `${claim}-previous-${stamp}`.slice(0, 63);

    // Keep both volumes whatever happens to their claims from here on.
    await this.setReclaim(currentPv, 'Retain', kubeconfig);
    await this.setReclaim(restoredPv, 'Retain', kubeconfig);

    await this.k8s.scaleWorkload(
      kubeconfig,
      'StatefulSet',
      namespace,
      statefulSet,
      0,
    );
    try {
      await this.waitGone(
        { apiVersion: 'v1', kind: 'Pod' },
        `${statefulSet}-0`,
        namespace,
        kubeconfig,
      );

      await this.k8s.deleteResource(
        kubeconfig,
        'PersistentVolumeClaim',
        claim,
        namespace,
      );
      await this.k8s.deleteResource(
        kubeconfig,
        'PersistentVolumeClaim',
        input.restoredClaim,
        namespace,
      );
      await this.waitGone(PVC, claim, namespace, kubeconfig);
      await this.waitGone(PVC, input.restoredClaim, namespace, kubeconfig);

      await this.release(restoredPv, kubeconfig);
      await this.release(currentPv, kubeconfig);

      await this.k8s.createObject(
        kubeconfig,
        this.claimFor(current, claim, restoredPv, current.metadata?.labels),
      );
      await this.k8s.createObject(
        kubeconfig,
        this.claimFor(current, previousClaim, currentPv, {
          ...current.metadata?.labels,
          'flui-app-id': input.appId,
          [PREVIOUS_VOLUME_LABEL]: 'true',
        }),
      );
      await this.waitBound(claim, namespace, kubeconfig);
      await this.waitBound(previousClaim, namespace, kubeconfig);
    } catch (err) {
      await this.putBack(input, claim, currentPv, kubeconfig);
      throw err;
    } finally {
      await this.k8s
        .scaleWorkload(
          kubeconfig,
          'StatefulSet',
          namespace,
          statefulSet,
          replicas,
        )
        .catch((e: Error) =>
          this.logger.error(
            `[sts-swap] could not scale ${namespace}/${statefulSet} back to ${replicas}: ${e.message}`,
          ),
        );
    }

    // Deleting a claim frees its volume again, as it did before the swap.
    await this.setReclaim(
      restoredPv,
      reclaim[restoredPv] ?? 'Delete',
      kubeconfig,
    );
    await this.setReclaim(
      currentPv,
      reclaim[currentPv] ?? 'Delete',
      kubeconfig,
    );

    this.logger.log(
      `[sts-swap] ${namespace}/${claim} now holds the restored data (${restoredPv}); the previous data is kept as ${previousClaim} (${currentPv})`,
    );
    return { claim, previousClaim };
  }

  /**
   * After a failure: the database's own claim must exist and hold its own
   * data again before it is scaled back up.
   */
  private async putBack(
    input: StatefulSetSwapInput,
    claim: string,
    currentPv: string,
    kubeconfig: string,
  ): Promise<void> {
    try {
      const existing = await this.read(kubeconfig, PVC, claim, input.namespace);
      if (existing) return;
      await this.release(currentPv, kubeconfig);
      const pv = await this.read(kubeconfig, PV, currentPv);
      await this.k8s.createObject(kubeconfig, {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: { name: claim, namespace: input.namespace },
        spec: {
          accessModes: ['ReadWriteOnce'],
          volumeName: currentPv,
          storageClassName: pv?.spec?.storageClassName,
          resources: {
            requests: {
              storage: pv?.spec?.capacity?.storage ?? '1Gi',
            },
          },
        },
      });
      this.logger.warn(
        `[sts-swap] ${claim} put back on its own volume ${currentPv}`,
      );
    } catch (err) {
      this.logger.error(
        `[sts-swap] could not put ${claim} back on ${currentPv}: ${(err as Error).message}`,
      );
    }
  }

  private claimFor(
    template: any,
    name: string,
    volumeName: string,
    labels?: Record<string, string>,
  ): Record<string, unknown> {
    return {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name,
        namespace: template.metadata.namespace,
        ...(labels ? { labels } : {}),
      },
      spec: {
        accessModes: template.spec?.accessModes ?? ['ReadWriteOnce'],
        storageClassName: template.spec?.storageClassName,
        resources: template.spec?.resources,
        volumeName,
      },
    };
  }

  private async setReclaim(pv: string, policy: string, kubeconfig: string) {
    await this.k8s.mergePatchObject(kubeconfig, {
      ...PV,
      metadata: { name: pv },
      spec: { persistentVolumeReclaimPolicy: policy },
    });
  }

  /** A released volume keeps the claim it had; clearing it lets a new claim bind. */
  private async release(pv: string, kubeconfig: string) {
    await this.k8s.mergePatchObject(kubeconfig, {
      ...PV,
      metadata: { name: pv },
      spec: { claimRef: null },
    });
  }

  private read(
    kubeconfig: string,
    type: { apiVersion: string; kind: string },
    name: string,
    namespace?: string,
  ): Promise<any> {
    return this.k8s.readObject(
      kubeconfig,
      type.apiVersion,
      type.kind,
      name,
      namespace,
    );
  }

  private async waitGone(
    type: { apiVersion: string; kind: string },
    name: string,
    namespace: string,
    kubeconfig: string,
  ) {
    await this.poll(
      async () => !(await this.read(kubeconfig, type, name, namespace)),
      `${type.kind} ${name} is still there`,
    );
  }

  private async waitBound(name: string, namespace: string, kubeconfig: string) {
    await this.poll(
      async () =>
        (await this.read(kubeconfig, PVC, name, namespace))?.status?.phase ===
        'Bound',
      `${name} did not bind`,
    );
  }

  private async poll(done: () => Promise<boolean>, timeoutMessage: string) {
    const deadline = Date.now() + WAIT_MS;
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error(timeoutMessage);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}
