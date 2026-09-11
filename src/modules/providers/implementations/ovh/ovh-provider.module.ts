import { Module } from '@nestjs/common';
import { CloudProvider } from '../../enums/cloud-provider.enum';
import { OvhProviderService } from './ovh-provider.service';
import { OvhCapabilitiesService } from './ovh-capabilities.service';
import {
  CLOUD_PROVIDER_REGISTRY,
  CAPABILITIES_PROVIDER_REGISTRY,
  CloudProviderRegistration,
  CapabilitiesProviderRegistration,
  multiProvider,
} from '../../core/tokens';

/**
 * OVH provider module — OpenStack (Nova/Neutron) under the hood, via
 * @flui-cloud/infra. No firewall/DNS registration here: OVH's firewall
 * capability resolves to 'host-nftables' (see OvhCapabilitiesService), which
 * ProvidersModule already routes through the shared NftablesFirewallBackend
 * for any provider declaring that backend; OVH does not support Flui-managed
 * DNS zones.
 */
@Module({
  providers: [
    OvhProviderService,
    OvhCapabilitiesService,

    multiProvider<CapabilitiesProviderRegistration>({
      provide: CAPABILITIES_PROVIDER_REGISTRY,
      useFactory: (
        s: OvhCapabilitiesService,
      ): CapabilitiesProviderRegistration => ({
        provider: CloudProvider.OVH,
        service: s,
      }),
      inject: [OvhCapabilitiesService],
      multi: true,
    }),

    multiProvider<CloudProviderRegistration>({
      provide: CLOUD_PROVIDER_REGISTRY,
      useFactory: (s: OvhProviderService): CloudProviderRegistration => ({
        provider: CloudProvider.OVH,
        service: s,
      }),
      inject: [OvhProviderService],
      multi: true,
    }),
  ],
  exports: [
    OvhProviderService,
    OvhCapabilitiesService,
    CLOUD_PROVIDER_REGISTRY,
    CAPABILITIES_PROVIDER_REGISTRY,
  ],
})
export class OvhProviderModule {}
