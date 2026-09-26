import { Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { acmeResolverState } from '../utils/acme-resolvers.core';

const NAMESPACE = 'cert-manager';
const DEPLOYMENT = 'cert-manager';

export interface AcmeResolverReading {
  pinned: boolean;
  nameservers: string | null;
}

@Injectable()
export class AcmeResolversService {
  private readonly logger = new Logger(AcmeResolversService.name);
  private readonly settled = new Set<string>();

  constructor(private readonly kubernetesService: KubernetesService) {}

  /** Null when cert-manager cannot be read on the cluster. */
  async read(kubeconfig: string): Promise<AcmeResolverReading | null> {
    const container = await this.controller(kubeconfig);
    if (!container) return null;
    const { pinned, nameservers } = acmeResolverState(container.args);
    return { pinned, nameservers };
  }

  /**
   * Pins the resolvers once per cluster and process; a cluster already pinned
   * costs one read. Never throws: a certificate check through the cluster's
   * resolver is slower, not broken, and must not stop an endpoint.
   */
  async ensure(
    clusterId: string,
    kubeconfig: string,
    options: { force?: boolean } = {},
  ): Promise<boolean> {
    if (this.settled.has(clusterId) && !options.force) return false;
    try {
      const container = await this.controller(kubeconfig);
      if (!container) return false;
      const state = acmeResolverState(container.args);
      if (state.nextArgs) {
        await this.kubernetesService.patchDeploymentContainerArgs(
          kubeconfig,
          NAMESPACE,
          DEPLOYMENT,
          container.name,
          state.nextArgs,
        );
        this.logger.log(
          `[acme-resolvers] cluster=${clusterId} pinned to public resolvers`,
        );
      }
      this.settled.add(clusterId);
      return !!state.nextArgs;
    } catch (err) {
      this.logger.warn(
        `[acme-resolvers] cluster=${clusterId} could not be pinned: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private async controller(
    kubeconfig: string,
  ): Promise<{ name: string; args: string[] } | null> {
    const resource = await this.kubernetesService.getResource(
      kubeconfig,
      'Deployment',
      DEPLOYMENT,
      NAMESPACE,
    );
    const body = resource?.body ?? resource;
    const container = body?.spec?.template?.spec?.containers?.[0];
    if (!container?.name) return null;
    return { name: container.name, args: container.args ?? [] };
  }
}
