import { Injectable, Logger } from '@nestjs/common';
import { CapabilitiesProviderFactory } from '../../../providers/core/factories/capabilities-provider.factory';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import {
  AutoscaleActuation,
  AutoscaleActuationFacts,
  describeAutoscaleActuation,
  resolveAutoscaleActuation,
} from './autoscale-actuation';
import { AutoscaleReconcilerRegistry } from './autoscale-reconciler.registry';

@Injectable()
export class AutoscaleActuationService {
  private readonly logger = new Logger(AutoscaleActuationService.name);

  constructor(
    private readonly capabilitiesFactory: CapabilitiesProviderFactory,
    private readonly reconcilers: AutoscaleReconcilerRegistry,
  ) {}

  async resolveFacts(
    provider: string,
    clusterId?: string,
  ): Promise<AutoscaleActuationFacts> {
    const providerEnum = provider as CloudProvider;
    const capabilities = this.capabilitiesFactory.isProviderSupported(
      providerEnum,
    )
      ? this.capabilitiesFactory.getCapabilitiesService(providerEnum)
      : null;

    const nodeProvisioning =
      capabilities?.getStaticCapabilities().features.nodeProvisioning ?? false;

    // Asked only where it changes the answer: with provisioning the catalogue
    // decides nothing, and on the provisioning providers this call reaches the
    // provider API.
    let hasSizeCatalog = false;
    if (!nodeProvisioning && capabilities) {
      try {
        const types = await capabilities.getSupportedInstanceTypes();
        hasSizeCatalog = types.length > 0;
      } catch (err) {
        this.logger.warn(
          `Instance types unavailable for ${provider}: ${(err as Error).message}`,
        );
      }
    }

    return {
      provider,
      nodeProvisioning,
      hasSizeCatalog,
      // Asked of the cluster wherever there is one to ask about: something being
      // registered says the installation *can* act, and a cluster with no group
      // set to buy is one this installation will never touch. Told apart, or the
      // capacity gate promises a node to a cluster nothing will ever add one to.
      driven: clusterId
        ? await this.reconcilers.drivesCluster(clusterId)
        : this.reconcilers.driven,
    };
  }

  async describe(
    provider: string,
    clusterId?: string,
  ): Promise<{
    facts: AutoscaleActuationFacts;
    actuation: AutoscaleActuation;
    message: string;
  }> {
    const facts = await this.resolveFacts(provider, clusterId);
    const actuation = resolveAutoscaleActuation(facts);
    return {
      facts,
      actuation,
      message: describeAutoscaleActuation(actuation, provider),
    };
  }
}
