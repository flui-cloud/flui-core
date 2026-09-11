import { Global, Module } from '@nestjs/common';
import { CliCredentialProviderService } from './lib/cli-credential-provider.service';
import { IpDetectionService } from './lib/utils/ip-detection';
import { CliFirewallRepository } from './lib/repositories/cli-firewall.repository';
import { CliVnetRepository } from './lib/repositories/cli-vnet.repository';
import { VnetProvisioningService } from './lib/services/vnet-provisioning.service';
import { ApiClient } from './lib/api-client';
import { ConfigStorage } from './lib/config-storage';
import { ProviderCoreModule } from 'src/modules/providers/provider-core.module';
import { CommonModule } from 'src/modules/common/common.module';
import { HetznerProviderModule } from 'src/modules/providers/implementations/hetzner/hetzner-provider.module';
import { ScalewayProviderModule } from 'src/modules/providers/implementations/scaleway/scaleway-provider.module';
import { OvhProviderModule } from 'src/modules/providers/implementations/ovh/ovh-provider.module';
import { OvhProviderService } from 'src/modules/providers/implementations/ovh/ovh-provider.service';
import { ProviderFactory } from 'src/modules/providers/core/factories/provider.factory';
import { FirewallProviderFactory } from 'src/modules/providers/core/factories/firewall-provider.factory';
import { DnsProviderFactory } from 'src/modules/providers/core/factories/dns-provider.factory';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { DnsProvider } from 'src/modules/providers/enums/dns-provider.enum';
import { HetznerProviderService } from 'src/modules/providers/services/hetzner-provider.service';
import { HetznerFirewallService } from 'src/modules/providers/services/hetzner-firewall.service';
import { HetznerDnsService } from 'src/modules/providers/services/hetzner-dns.service';
import { ScalewayProviderService } from 'src/modules/providers/implementations/scaleway/scaleway-provider.service';
import { ScalewayFirewallService } from 'src/modules/providers/implementations/scaleway/scaleway-firewall.service';
import { ScalewayDnsService } from 'src/modules/providers/implementations/scaleway/scaleway-dns.service';
import { HetznerBootstrapSeeder } from 'src/modules/providers/implementations/hetzner/hetzner-bootstrap-seeder.service';
import { ScalewayBootstrapSeeder } from 'src/modules/providers/implementations/scaleway/scaleway-bootstrap-seeder.service';
import {
  PROVIDER_BOOTSTRAP_SEEDER_REGISTRY,
  ProviderBootstrapSeederRegistration,
} from 'src/modules/providers/core/tokens';

@Global()
@Module({
  imports: [
    ProviderCoreModule,
    CommonModule,
    HetznerProviderModule,
    ScalewayProviderModule,
    OvhProviderModule,
  ],
  providers: [
    CliCredentialProviderService,
    {
      provide: 'ICredentialProvider',
      useExisting: CliCredentialProviderService,
    },
    {
      provide: ProviderFactory,
      useFactory: (
        hetzner: HetznerProviderService,
        scaleway: ScalewayProviderService,
        ovh: OvhProviderService,
      ) =>
        new ProviderFactory([
          { provider: CloudProvider.HETZNER, service: hetzner },
          { provider: CloudProvider.SCALEWAY, service: scaleway },
          { provider: CloudProvider.OVH, service: ovh },
        ]),
      inject: [
        HetznerProviderService,
        ScalewayProviderService,
        OvhProviderService,
      ],
    },
    {
      provide: FirewallProviderFactory,
      useFactory: (
        hetzner: HetznerFirewallService,
        scaleway: ScalewayFirewallService,
      ) =>
        new FirewallProviderFactory([
          { provider: CloudProvider.HETZNER, service: hetzner },
          { provider: CloudProvider.SCALEWAY, service: scaleway },
        ]),
      inject: [HetznerFirewallService, ScalewayFirewallService],
    },
    {
      provide: DnsProviderFactory,
      useFactory: (hetzner: HetznerDnsService, scaleway: ScalewayDnsService) =>
        new DnsProviderFactory([
          { provider: DnsProvider.HETZNER, service: hetzner },
          { provider: DnsProvider.SCALEWAY, service: scaleway },
        ]),
      inject: [HetznerDnsService, ScalewayDnsService],
    },
    {
      provide: PROVIDER_BOOTSTRAP_SEEDER_REGISTRY,
      useFactory: (
        hetzner: HetznerBootstrapSeeder,
        scaleway: ScalewayBootstrapSeeder,
      ): ProviderBootstrapSeederRegistration[] => [
        { provider: CloudProvider.HETZNER, service: hetzner },
        { provider: CloudProvider.SCALEWAY, service: scaleway },
      ],
      inject: [HetznerBootstrapSeeder, ScalewayBootstrapSeeder],
    },
    {
      provide: ApiClient,
      useFactory: () => {
        const configStorage = new ConfigStorage();
        return new ApiClient({
          baseUrl: configStorage.getApiUrl() ?? '',
          apiKey: configStorage.getApiKey(),
        });
      },
    },
    IpDetectionService,
    CliFirewallRepository,
    CliVnetRepository,
    VnetProvisioningService,
  ],
  exports: [
    ProviderCoreModule,
    CliCredentialProviderService,
    'ICredentialProvider',
    HetznerProviderModule,
    ScalewayProviderModule,
    OvhProviderModule,
    ProviderFactory,
    FirewallProviderFactory,
    DnsProviderFactory,
    PROVIDER_BOOTSTRAP_SEEDER_REGISTRY,
    ApiClient,
    IpDetectionService,
    CliFirewallRepository,
    CliVnetRepository,
    VnetProvisioningService,
  ],
})
export class CliProvidersModule {}
