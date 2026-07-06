import { Injectable, Logger, Inject } from '@nestjs/common';
import {
  Configuration,
  PrivateNetworksApi,
  SubnetsApi,
  ScalewayVpcV2PrivateNetwork,
  CreatePrivateNetworkRegionEnum,
  DeletePrivateNetworkRegionEnum,
  GetPrivateNetworkRegionEnum,
  ListPrivateNetworksRegionEnum,
  AddSubnetsRegionEnum,
  DeleteSubnetsRegionEnum,
} from './generated/vpc';
import {
  PrivateNetworksApi as BaremetalPrivateNetworksApi,
  AddServerPrivateNetworkZoneEnum,
  DeleteServerPrivateNetworkZoneEnum,
} from './generated/private-network';
import {
  VNetCreationResult,
  VNetDetails,
  VNetSubnetInfo,
} from '../../interfaces/network-provider.interface';
import { ICredentialProvider } from '../../interfaces/credential-provider.interface';
import { CloudProvider } from '../../enums/cloud-provider.enum';
import { ScalewayIamAdapter } from './scaleway-iam.adapter';

@Injectable()
export class ScalewayVpcAdapter {
  private readonly logger = new Logger(ScalewayVpcAdapter.name);

  constructor(
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
    private readonly iamAdapter: ScalewayIamAdapter,
  ) {}

  // ─── VNet ID helpers ─────────────────────────────────────────────────────────

  /** Encode region + private network UUID into a Flui vnetId */
  buildVnetId(region: string, privateNetworkId: string): string {
    return `${region}:${privateNetworkId}`;
  }

  /** Decode a Flui vnetId back to { region, id } */
  parseVnetId(vnetId: string): { region: string; id: string } {
    const colonIdx = vnetId.indexOf(':');
    if (colonIdx === -1) {
      return { region: 'fr-par', id: vnetId };
    }
    return {
      region: vnetId.substring(0, colonIdx),
      id: vnetId.substring(colonIdx + 1),
    };
  }

  /** Derive region from a Scaleway zone (e.g. 'fr-par-1' → 'fr-par') */
  zoneToRegion(zone: string): string {
    const parts = zone.split('-');
    // e.g. 'fr-par-1' → ['fr','par','1'] → 'fr-par'
    // e.g. 'nl-ams-1' → ['nl','ams','1'] → 'nl-ams'
    // e.g. 'pl-waw-2' → ['pl','waw','2'] → 'pl-waw'
    if (parts.length >= 3) {
      return `${parts[0]}-${parts[1]}`;
    }
    return zone;
  }

  // ─── API factories ───────────────────────────────────────────────────────────

  private async createPrivateNetworksApi(): Promise<PrivateNetworksApi> {
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );
    return new PrivateNetworksApi(
      new Configuration({
        baseOptions: { headers: { 'X-Auth-Token': token } },
      }),
    );
  }

  private async createSubnetsApi(): Promise<SubnetsApi> {
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );
    return new SubnetsApi(
      new Configuration({
        baseOptions: { headers: { 'X-Auth-Token': token } },
      }),
    );
  }

  private async createBaremetalPrivateNetworksApi(): Promise<BaremetalPrivateNetworksApi> {
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );
    return new BaremetalPrivateNetworksApi(
      new Configuration({
        baseOptions: { headers: { 'X-Auth-Token': token } },
      }),
    );
  }

  // ─── Private Network (VNet) operations ──────────────────────────────────────

  async createPrivateNetwork(
    region: string,
    name: string,
    tags: string[],
    subnets: string[],
  ): Promise<VNetCreationResult> {
    const projectId = await this.iamAdapter.getDefaultProjectId();
    this.logger.log(
      `Creating Scaleway private network: name=${name} region=${region} project_id=${projectId} subnets=${JSON.stringify(subnets)}`,
    );

    const api = await this.createPrivateNetworksApi();
    let resp: Awaited<ReturnType<typeof api.createPrivateNetwork>>;
    try {
      resp = await api.createPrivateNetwork(
        region as CreatePrivateNetworkRegionEnum,
        { name, project_id: projectId, tags, subnets },
      );
    } catch (err) {
      const status = err?.response?.status;
      const detail = err?.response?.data ?? err?.message;
      this.logger.error(
        `Scaleway createPrivateNetwork failed: status=${status} detail=${JSON.stringify(detail)}`,
      );
      throw new Error(this.describeVpcError(detail, subnets, region));
    }

    const pn = resp.data;
    const ipRange = pn.subnets?.[0]?.subnet ?? subnets[0] ?? '';
    this.logger.log(
      `Scaleway private network created: id=${pn.id} region=${region} ipRange=${ipRange}`,
    );
    return {
      vnetId: this.buildVnetId(region, pn.id ?? ''),
      ipRange,
      subnets: (pn.subnets ?? []).map((s) => ({
        ipRange: s.subnet ?? '',
        type: 'cloud',
        networkZone: region,
      })),
    };
  }

  /** Turn Scaleway's VPC validation payload into an actionable, user-facing message. */
  private describeVpcError(
    detail: any,
    subnets: string[],
    region: string,
  ): string {
    const first = Array.isArray(detail?.details)
      ? detail.details[0]
      : undefined;
    const help: string = first?.help_message ?? '';
    if (help.includes('subnet_overlaps_in_vpc')) {
      return `Subnet ${subnets.join(', ')} overlaps an existing private network in your Scaleway VPC (${region}). Choose a different IP range.`;
    }
    if (detail?.message) {
      const reason = help ? ` (${help.split(':')[0].trim()})` : '';
      return `Scaleway rejected the network: ${detail.message}${reason}`;
    }
    return typeof detail === 'string'
      ? detail
      : 'Scaleway rejected the private network request.';
  }

  async deletePrivateNetwork(
    region: string,
    privateNetworkId: string,
  ): Promise<void> {
    const api = await this.createPrivateNetworksApi();
    await api.deletePrivateNetwork(
      region as DeletePrivateNetworkRegionEnum,
      privateNetworkId,
    );
  }

  async getPrivateNetwork(
    region: string,
    privateNetworkId: string,
  ): Promise<VNetDetails | null> {
    try {
      const api = await this.createPrivateNetworksApi();
      const resp = await api.getPrivateNetwork(
        region as GetPrivateNetworkRegionEnum,
        privateNetworkId,
      );
      return this.mapPrivateNetwork(resp.data);
    } catch (e) {
      if (e.response?.status === 404) return null;
      throw e;
    }
  }

  async listPrivateNetworks(region: string): Promise<VNetDetails[]> {
    const api = await this.createPrivateNetworksApi();
    const resp = await api.listPrivateNetworks(
      region as ListPrivateNetworksRegionEnum,
    );
    return (resp.data.private_networks ?? []).map((pn) =>
      this.mapPrivateNetwork(pn),
    );
  }

  // ─── Subnet operations ───────────────────────────────────────────────────────

  async addSubnets(
    region: string,
    privateNetworkId: string,
    subnets: string[],
  ): Promise<void> {
    const api = await this.createSubnetsApi();
    await api.addSubnets(region as AddSubnetsRegionEnum, privateNetworkId, {
      subnets,
    });
  }

  async deleteSubnets(
    region: string,
    privateNetworkId: string,
    subnets: string[],
  ): Promise<void> {
    const api = await this.createSubnetsApi();
    await api.deleteSubnets(
      region as DeleteSubnetsRegionEnum,
      privateNetworkId,
      { subnets },
    );
  }

  // ─── Server attachment (Elastic Metal only) ──────────────────────────────────

  async attachBaremetalToPrivateNetwork(
    zone: string,
    serverId: string,
    privateNetworkId: string,
  ): Promise<void> {
    const api = await this.createBaremetalPrivateNetworksApi();
    await api.addServerPrivateNetwork(
      zone as AddServerPrivateNetworkZoneEnum,
      serverId,
      { private_network_id: privateNetworkId },
    );
    this.logger.log(
      `Elastic Metal server ${serverId} attached to private network ${privateNetworkId} in zone ${zone}`,
    );
  }

  async detachBaremetalFromPrivateNetwork(
    zone: string,
    serverId: string,
    privateNetworkId: string,
  ): Promise<void> {
    const api = await this.createBaremetalPrivateNetworksApi();
    await api.deleteServerPrivateNetwork(
      zone as DeleteServerPrivateNetworkZoneEnum,
      serverId,
      privateNetworkId,
    );
    this.logger.log(
      `Elastic Metal server ${serverId} detached from private network ${privateNetworkId} in zone ${zone}`,
    );
  }

  // ─── Mapping helpers ─────────────────────────────────────────────────────────

  private mapPrivateNetwork(pn: ScalewayVpcV2PrivateNetwork): VNetDetails {
    const region = pn.region ?? 'fr-par';
    const subnets: VNetSubnetInfo[] = (pn.subnets ?? []).map((s) => ({
      id: s.id,
      ipRange: s.subnet ?? '',
      type: 'cloud',
      networkZone: region,
    }));

    return {
      id: this.buildVnetId(region, pn.id ?? ''),
      name: pn.name ?? '',
      ipRange: pn.subnets?.[0]?.subnet ?? '',
      subnets,
      routes: [],
      attachedServerIds: [],
      labels: (pn.tags ?? []).reduce<Record<string, string>>((acc, tag) => {
        const eqIdx = tag.indexOf('=');
        if (eqIdx === -1) {
          acc[tag] = '';
        } else {
          acc[tag.substring(0, eqIdx)] = tag.substring(eqIdx + 1);
        }
        return acc;
      }, {}),
      created: pn.created_at,
    };
  }
}
