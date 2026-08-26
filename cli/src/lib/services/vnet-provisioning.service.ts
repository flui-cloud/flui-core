import { Injectable, Logger } from '@nestjs/common';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { ProviderFactory } from 'src/modules/providers/core/factories/provider.factory';
import {
  SubnetType,
  VNetSubnetEntity,
} from 'src/modules/infrastructure/vnets/entities/vnet-subnet.entity';
import { VNetStatus } from 'src/modules/infrastructure/vnets/entities/vnet.entity';
import { CliVnetRepository } from '../repositories/cli-vnet.repository';

export interface EnvVnetSpec {
  provider: CloudProvider;
  name: string;
  ipRange?: string;
  subnetIpRange?: string;
  /** Hetzner: networkZone (eu-central). Scaleway: regional, ignored. */
  networkZone?: string;
  /** Scaleway: region (fr-par, nl-ams, pl-waw). Hetzner: ignored. */
  region?: string;
}

export interface EnvVnetInfo {
  vnetId: string;
  vnetProviderResourceId: string;
  vnetName: string;
  vnetIpRange: string;
  subnetId: string;
  subnetProviderResourceId: string;
  subnetIpRange: string;
  subnetType: SubnetType;
  networkZone: string;
  /**
   * False when an existing VNet was reused. A caller that reports resources to
   * whoever will have to clean them up must not claim to have created one it
   * only joined.
   */
  created: boolean;
}

const HETZNER_DEFAULT_NETWORK_ZONE_BY_REGION: Record<string, string> = {
  nbg1: 'eu-central',
  fsn1: 'eu-central',
  hel1: 'eu-central',
  ash: 'us-east',
  hil: 'us-west',
};

@Injectable()
export class VnetProvisioningService {
  private readonly logger = new Logger(VnetProvisioningService.name);

  constructor(
    private readonly providerFactory: ProviderFactory,
    private readonly vnetRepo: CliVnetRepository,
  ) {}

  async ensureEnvVnet(spec: EnvVnetSpec): Promise<EnvVnetInfo> {
    const existing = await this.vnetRepo.findActive();
    if (existing?.provider === spec.provider) {
      const subnet = existing.subnets?.[0];
      if (!subnet) {
        throw new Error(
          `VNet ${existing.providerResourceId} has no subnet — recreate the environment`,
        );
      }
      this.logger.log(
        `Reusing existing VNet ${existing.providerResourceId} (subnet ${subnet.providerSubnetId})`,
      );
      return this.toInfo(existing, subnet, false);
    }

    const ipRange = spec.ipRange || '10.10.0.0/16';
    const subnetIpRange = spec.subnetIpRange || '10.10.1.0/24';

    if (spec.provider === CloudProvider.HETZNER) {
      return this.createHetznerVnet(spec, ipRange, subnetIpRange);
    }
    if (spec.provider === CloudProvider.SCALEWAY) {
      return this.createScalewayVnet(spec, ipRange, subnetIpRange);
    }
    throw new Error(
      `VNet provisioning not yet implemented for provider ${spec.provider}`,
    );
  }

  private async createHetznerVnet(
    spec: EnvVnetSpec,
    ipRange: string,
    subnetIpRange: string,
  ): Promise<EnvVnetInfo> {
    const networkZone = spec.networkZone || 'eu-central';
    this.logger.log(`Creating Hetzner VNet ${spec.name} (${ipRange})`);
    const provider = this.providerFactory.getProvider(CloudProvider.HETZNER);
    if (!provider.createVNet) {
      throw new Error('Hetzner provider does not implement createVNet');
    }
    const created = await provider.createVNet({
      name: spec.name,
      ipRange,
      labels: [
        { key: 'managed-by', value: 'flui-cloud' },
        { key: 'flui-resource-type', value: 'vnet' },
      ],
      subnets: [{ ipRange: subnetIpRange, networkZone }],
    });

    const vnetRecord = await this.vnetRepo.save({
      providerResourceId: created.vnetId,
      name: spec.name,
      provider: spec.provider,
      ipRange: created.ipRange,
      labels: [
        { key: 'managed-by', value: 'flui-cloud' },
        { key: 'flui-resource-type', value: 'vnet' },
      ],
      status: VNetStatus.ACTIVE,
      subnets: [],
    });

    const subnetRecord = await this.vnetRepo.addSubnet(vnetRecord.id, {
      providerSubnetId: subnetIpRange,
      ipRange: subnetIpRange,
      type: SubnetType.CLOUD,
      networkZone,
    });

    return this.toInfo(
      { ...vnetRecord, subnets: [subnetRecord] },
      subnetRecord,
      true,
    );
  }

  private async createScalewayVnet(
    spec: EnvVnetSpec,
    ipRange: string,
    subnetIpRange: string,
  ): Promise<EnvVnetInfo> {
    const region = spec.region || 'fr-par';
    this.logger.log(
      `Creating Scaleway Private Network ${spec.name} in ${region} (${ipRange})`,
    );
    const provider = this.providerFactory.getProvider(CloudProvider.SCALEWAY);
    if (!provider.createVNet) {
      throw new Error('Scaleway provider does not implement createVNet');
    }
    const created = await provider.createVNet({
      name: spec.name,
      ipRange,
      labels: [
        { key: 'managed-by', value: 'flui-cloud' },
        { key: 'flui-resource-type', value: 'vnet' },
        { key: 'region', value: region },
      ],
      subnets: [{ ipRange: subnetIpRange, networkZone: region }],
    });

    const vnetRecord = await this.vnetRepo.save({
      providerResourceId: created.vnetId,
      name: spec.name,
      provider: spec.provider,
      ipRange: created.ipRange,
      labels: [
        { key: 'managed-by', value: 'flui-cloud' },
        { key: 'flui-resource-type', value: 'vnet' },
        { key: 'region', value: region },
      ],
      status: VNetStatus.ACTIVE,
      subnets: [],
    });

    const subnetRecord = await this.vnetRepo.addSubnet(vnetRecord.id, {
      providerSubnetId: subnetIpRange,
      ipRange: subnetIpRange,
      type: SubnetType.CLOUD,
      networkZone: region,
    });

    return this.toInfo(
      { ...vnetRecord, subnets: [subnetRecord] },
      subnetRecord,
      true,
    );
  }

  async destroyEnvVnet(): Promise<void> {
    const existing = await this.vnetRepo.findActive();
    if (!existing) return;
    try {
      const provider = this.providerFactory.getProvider(existing.provider);
      if (provider.deleteVNet) {
        await provider.deleteVNet(existing.providerResourceId);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to delete VNet ${existing.providerResourceId} on ${existing.provider}: ${(error as Error).message}`,
      );
    }
    await this.vnetRepo.remove(existing.id);
  }

  hetznerNetworkZoneFor(region: string): string {
    return HETZNER_DEFAULT_NETWORK_ZONE_BY_REGION[region] || 'eu-central';
  }

  private toInfo(
    vnet: {
      id: string;
      providerResourceId: string;
      name: string;
      ipRange: string;
      subnets?: VNetSubnetEntity[];
    },
    subnet: VNetSubnetEntity,
    created: boolean,
  ): EnvVnetInfo {
    return {
      vnetId: vnet.id,
      vnetProviderResourceId: vnet.providerResourceId,
      vnetName: vnet.name,
      vnetIpRange: vnet.ipRange,
      subnetId: subnet.id,
      subnetProviderResourceId: subnet.providerSubnetId || subnet.ipRange,
      subnetIpRange: subnet.ipRange,
      subnetType: subnet.type,
      networkZone: subnet.networkZone,
      created,
    };
  }
}
