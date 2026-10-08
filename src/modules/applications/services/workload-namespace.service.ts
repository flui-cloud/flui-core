import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { PROJECT_LABEL } from '../../projects/project-spaces.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EgressPolicyService } from '../../infrastructure/egress/egress-policy.service';
import {
  SANDBOX_LABEL,
  isSystemNamespace,
} from '../../infrastructure/egress/egress-policy.core';

/** The ceiling a container gets when it declares none of its own. */
export const WORKLOAD_EPHEMERAL_DEFAULT = '8Gi';

/**
 * Explicit, because a LimitRange copies `default` into `defaultRequest` when the
 * latter is left out — and an 8Gi request would fit eight pods on a node with
 * 71GiB to give. Measured on a real node: the kubelet rotates container logs at
 * 10Mi and keeps five of them, so an idle container can hold 50Mi of logs; the
 * request sits clear of that, or a quiet pod would be ranked for eviction
 * beside a genuine runaway when the node fills.
 */
export const WORKLOAD_EPHEMERAL_REQUEST = '256Mi';

export const WORKLOAD_LIMIT_RANGE_NAME = 'flui-workload-limits';
export const PROJECT_SPACE_CLEARING_CODE = 'PROJECT_SPACE_CLEARING';
export const PROJECT_SPACE_TAKEN_CODE = 'PROJECT_SPACE_TAKEN';

/**
 * The namespace an application is deployed into, and the one ceiling it carries.
 *
 * `ephemeral-storage` — the writable layer, the logs, any emptyDir — is the
 * only byte ceiling the kubelet enforces, and what it protects is the node's
 * own disk, shared with k3s and its datastore.
 *
 * It belongs to the namespace and not to each manifest: a value in a workload's
 * spec overrides the namespace's LimitRange, and a sandbox tenancy is dosed by
 * one. Two LimitRanges in a namespace are worse still — Kubernetes intersects
 * their constraints but picks a default non-deterministically — so ours must
 * never reach a tenancy. Setting it here also caps pods Flui never wrote, which
 * a manifest could not.
 */
@Injectable()
export class WorkloadNamespaceService {
  private readonly logger = new Logger(WorkloadNamespaceService.name);

  constructor(
    private readonly kubernetesService: KubernetesService,
    private readonly egress: EgressPolicyService,
    @InjectRepository(ProjectEntity)
    private readonly projects: Repository<ProjectEntity>,
  ) {}

  /**
   * With a cluster, the cluster's egress rule is written too, except in a
   * platform namespace.
   */
  async ensure(
    kubeconfig: string,
    namespace: string,
    labels: Record<string, string> = {},
    clusterId?: string,
  ): Promise<void> {
    await this.kubernetesService.ensureNamespaceExists(
      kubeconfig,
      namespace,
      labels,
    );
    const current = await this.labelsOf(kubeconfig, namespace);
    const holder = current?.[PROJECT_LABEL];
    const wanted = labels[PROJECT_LABEL];
    if (holder && wanted && holder !== wanted) {
      await this.refuseForeignSpace(kubeconfig, namespace, holder);
    }
    if (current && clusterId && !isSystemNamespace(current)) {
      await this.egress.applyTo(
        kubeconfig,
        clusterId,
        namespace,
        current[SANDBOX_LABEL] === 'true',
      );
    }
    if (!current || current[SANDBOX_LABEL] === 'true') {
      this.logger.debug(
        `Namespace ${namespace} is a sandbox tenancy or unreadable; its own limits govern it`,
      );
      return;
    }
    await this.kubernetesService.applyManifest(
      kubeconfig,
      buildWorkloadLimitRange(namespace),
    );
  }

  /**
   * A space left by a deleted project whose cluster did not answer when it was
   * deleted. Never inherited: it is removed, and the deploy is asked to come
   * back once it is gone.
   */
  private async refuseForeignSpace(
    kubeconfig: string,
    namespace: string,
    holder: string,
  ): Promise<never> {
    if (await this.projects.exists({ where: { id: holder } })) {
      throw new ConflictException({
        code: PROJECT_SPACE_TAKEN_CODE,
        message: `The space ${namespace} on this cluster belongs to another project.`,
      });
    }
    await this.kubernetesService.deleteNamespace(kubeconfig, namespace);
    throw new ConflictException({
      code: PROJECT_SPACE_CLEARING_CODE,
      message: `The space ${namespace} still held what a deleted project with the same name left on this cluster. It is being removed; deploy again in a minute.`,
    });
  }

  /**
   * Read off the namespace, not the database: the label is written before a
   * guest can deploy, and the deploy path already has the namespace in hand.
   * A failed read means "leave it alone" — a namespace without a ceiling costs
   * one deploy; a tenancy losing its own costs the tenancy.
   */
  private async labelsOf(
    kubeconfig: string,
    namespace: string,
  ): Promise<Record<string, string> | null> {
    try {
      const ns = await this.kubernetesService.getResource(
        kubeconfig,
        'Namespace',
        namespace,
      );
      return ns?.metadata?.labels ?? {};
    } catch (error) {
      this.logger.warn(
        `Could not read namespace ${namespace}, leaving its limits alone: ${(error as Error).message}`,
      );
      return null;
    }
  }
}

/**
 * `ephemeral-storage` only, and no `max`.
 *
 * A `max` is refused at pod creation, which is the invisible failure this file
 * exists because of, and outside a sandbox no per-tenant quota needs one. Nor
 * cpu or memory: the same namespace holds catalog and Helm pods that never
 * asked for a ceiling.
 */
export function buildWorkloadLimitRange(namespace: string): string {
  return `apiVersion: v1
kind: LimitRange
metadata:
  name: ${WORKLOAD_LIMIT_RANGE_NAME}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: flui
    flui.cloud/managed-by: flui-cloud
spec:
  limits:
    - type: Container
      default:
        ephemeral-storage: "${WORKLOAD_EPHEMERAL_DEFAULT}"
      defaultRequest:
        ephemeral-storage: "${WORKLOAD_EPHEMERAL_REQUEST}"
`;
}
