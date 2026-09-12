import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OvhProviderService as InfraOvhProviderService,
  packRegionId,
  parseRegionId,
} from '@flui-cloud/infra';
import {
  ICloudProvider,
  CreateServerConfig,
  ServerCreationResult,
  ServerDeletionResult,
  SSHKeyCreationResult,
  AttachedVolumeResult,
  ProviderVolumeSummary,
} from '../../interfaces/cloud-provider.interface';
import {
  CreateVNetConfig,
  VNetCreationResult,
  VNetDetails,
  VNetDeletionResult,
  AddSubnetConfig,
  DeleteSubnetConfig,
  AttachServerToVNetConfig,
  DetachServerFromVNetConfig,
  ServerVNetAttachmentResult,
} from '../../interfaces/network-provider.interface';
import { InstanceEntity } from '../../../instances/entities/instance.entity';
import { DeleteServerDto } from '../../../infrastructure/servers/dto/delete-server.dto';
import { ServerResponseDto } from '../../../infrastructure/servers/dto/server-response.dto';
import { NodeSizeDto } from '../../dto/node-size.dto';
import { CloudProvider } from '../../enums/cloud-provider.enum';
import { ICredentialProvider } from '../../interfaces/credential-provider.interface';
import { buildOvhOpenStackClient } from './ovh-openstack-client.factory';
import { FluiOpenStackClient } from './openstack-volumes-client';

/**
 * GPU flavors are real, orderable OVH products (@flui-cloud/infra's catalog
 * intentionally keeps them — see its ovh-flavor-denylist.ts), but Flui has no
 * GPU-aware workload story yet. Offering one as a K3s cluster node size would
 * let someone provision a many-thousands-EUR/month box for a control-plane
 * node by mistake. @flui-cloud/infra doesn't expose the catalog's
 * `technical.gpu` field, so this list stands in for it — verified against
 * OVH's live public catalog (eu.api.ovh.com/v1/order/catalog/public/cloud)
 * on 2026-09-12: every flavor with a non-null `technical.gpu` falls under one
 * of these plan-code prefixes.
 */
const OVH_GPU_FLAVOR_PREFIXES = [
  'a10-',
  'a100-',
  'g1-',
  'g2-',
  'g3-',
  'h100-',
  'h200-',
  'l4-',
  'l40s-',
  'rtx5000-',
  't1-',
  't2-',
];

function isOvhGpuFlavor(id: string): boolean {
  return OVH_GPU_FLAVOR_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Flui-native OVH provider — delegates the actual Nova/Neutron work to
 * @flui-cloud/infra's OvhProviderService, but sources credentials from
 * ICredentialProvider (the encrypted DB-backed store) instead of process env
 * vars, and re-resolves them on every call so a rotated credential takes
 * effect immediately, matching Hetzner/Scaleway.
 */
@Injectable()
export class OvhProviderService implements ICloudProvider {
  private readonly logger = new Logger(OvhProviderService.name);

  /** Catalog/pricing (getNodeSizes) needs no credentials — one shared instance is enough. */
  private readonly catalogOnly = new InfraOvhProviderService(
    this.configService,
  );

  constructor(
    private readonly configService: ConfigService,
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
  ) {}

  private async delegate(): Promise<InfraOvhProviderService> {
    const client = await this.client();
    return new InfraOvhProviderService(this.configService, client);
  }

  private async client(): Promise<FluiOpenStackClient> {
    const { accessKey, secretKey } =
      await this.credentialProvider.getActiveAccessKeyPair(CloudProvider.OVH);
    return buildOvhOpenStackClient(this.configService, accessKey, secretKey);
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const svc = await this.delegate();
      return svc.testConnection();
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async listInstances(): Promise<InstanceEntity[]> {
    return [];
  }

  async getNodeSizes(): Promise<NodeSizeDto[]> {
    const sizes = await this.catalogOnly.getNodeSizes();
    return sizes.filter((size) => !isOvhGpuFlavor(size.id));
  }

  async listServersAsDto(): Promise<ServerResponseDto[]> {
    const svc = await this.delegate();
    const servers = await svc.listServersAsDto();
    return servers.map((s) => toLocalServerDto(s));
  }

  async getServerDetailsAsDto(
    serverId: string,
  ): Promise<ServerResponseDto | null> {
    const svc = await this.delegate();
    const server = await svc.getServerDetailsAsDto(serverId);
    return server ? toLocalServerDto(server) : null;
  }

  async getServerStatus(serverId: string): Promise<string> {
    const svc = await this.delegate();
    return svc.getServerStatus(serverId);
  }

  async createServer(
    config: CreateServerConfig,
  ): Promise<ServerCreationResult> {
    const client = await this.client();
    const svc = new InfraOvhProviderService(this.configService, client);
    const region = await client.resolveComputeRegion(config.location);

    // Attaching a private VNet alongside Ext-Net at create time left the
    // instance stuck in BUILD with no IP ever assigned (OVH's own docs frame
    // Ext-Net-only as the reliable path to an automatic public IP; a private
    // network is meant to be added afterwards, via a Floating IP or a second
    // interface — not requested together at boot). So: boot on Ext-Net only,
    // then attach the private network(s) once the server is up.
    const result = await svc.createServer({
      ...config,
      image: toOvhImageName(config.image),
      networks: undefined,
    });

    // Nova's create response is 'BUILD' with no IP yet — unlike Hetzner/
    // Scaleway, which allocate a public IP synchronously at create time.
    // Every downstream caller assumes createServer() returns a usable IP, so
    // wait here instead of leaking that difference to the rest of Flui.
    // Nova also refuses os-interface attach while vm_state is still
    // 'building' — even after the IP shows up — so this waits for ACTIVE,
    // not just a truthy public_ip.
    if (!result.ipAddress || result.status !== 'ACTIVE') {
      const active = await this.waitForServerActive(svc, result.serverId);
      if (active) {
        result.ipAddress = active.public_ip ?? result.ipAddress;
        result.privateIp = active.private_ip ?? result.privateIp;
        result.status = active.status;
      }
    }

    // From here on, the server already exists at the provider. A failure in
    // either step below must not throw it away silently — the caller only
    // learns the serverId from this method's return value, so an exception
    // here would orphan a real, billed server with nothing left to clean it
    // up (this is exactly how one got stranded during development: the
    // interface-attach step failed and the caller never got serverId to
    // delete it). Best-effort delete before re-throwing.
    try {
      if (config.networks?.length) {
        for (const netId of config.networks) {
          await client.attachServerInterface(
            region,
            result.serverId,
            parseRegionId(netId).id,
          );
        }
      }

      if (config.attachedVolumes?.length) {
        const attached: AttachedVolumeResult[] = [];
        for (const vol of config.attachedVolumes) {
          const metadata = vol.labels?.length
            ? Object.fromEntries(vol.labels.map((l) => [l.key, l.value]))
            : undefined;
          const created = await client.createVolume(region, {
            name: vol.name,
            sizeGb: vol.sizeGb,
            metadata,
          });
          await client.waitForVolumeAvailable(region, created.id);
          const attachment = await client.attachVolumeToServer(
            region,
            result.serverId,
            created.id,
          );
          attached.push({
            volumeId: packRegionId(region, created.id),
            devicePath: attachment.device,
            sizeGb: vol.sizeGb,
          });
        }
        result.attachedVolumes = attached;
      }
    } catch (error) {
      await svc
        .deleteServer({
          server_id: result.serverId,
          provider: CloudProvider.OVH,
          force: true,
        })
        .catch(() => undefined);
      throw error;
    }

    return result;
  }

  private async waitForServerActive(
    svc: InfraOvhProviderService,
    serverId: string,
    timeoutMs = 120_000,
    pollIntervalMs = 3_000,
  ): Promise<{
    public_ip?: string;
    private_ip?: string;
    status: string;
  } | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const server = await svc.getServerDetailsAsDto(serverId);
      if (server?.public_ip && server.status === 'ACTIVE') return server;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return null;
  }

  async deleteServer(config: DeleteServerDto): Promise<ServerDeletionResult> {
    const svc = await this.delegate();
    return svc.deleteServer(config);
  }

  // ── Block storage (Cinder) volumes ──

  async expandVolume(
    volumeId: string,
    newSizeGb: number,
  ): Promise<{ actionId?: number }> {
    const client = await this.client();
    const { region, id } = parseRegionId(volumeId);
    if (!region) throw new Error(`OVH volume ${volumeId} not found.`);
    await client.extendVolume(region, id, newSizeGb);
    return {};
  }

  async detachVolume(volumeId: string): Promise<{ actionId?: number }> {
    const client = await this.client();
    const { region, id } = parseRegionId(volumeId);
    if (!region) throw new Error(`OVH volume ${volumeId} not found.`);
    const volume = await client.getVolume(region, id);
    if (!volume) return {};
    for (const attachment of volume.attachments) {
      await client.detachVolumeFromServer(
        region,
        attachment.server_id,
        attachment.attachment_id,
      );
    }
    return {};
  }

  async deleteVolume(volumeId: string): Promise<void> {
    const client = await this.client();
    const { region, id } = parseRegionId(volumeId);
    if (!region) throw new Error(`OVH volume ${volumeId} not found.`);
    await client.deleteVolume(region, id);
  }

  async listFluiManagedVolumes(): Promise<ProviderVolumeSummary[]> {
    const client = await this.client();
    const regions = await client.regions('volumev3');
    const perRegion = await Promise.all(
      regions.map(async (region) => {
        const volumes = await client.listVolumes(region);
        return volumes
          .filter((v) => v.metadata?.['managed-by'] === 'flui-cloud')
          .map(
            (v): ProviderVolumeSummary => ({
              volumeId: packRegionId(region, v.id),
              name: v.name,
              sizeGb: v.size,
              region,
              attachedServerId: v.attachments[0]?.server_id ?? null,
              labels: v.metadata ?? {},
              createdAt: v.created_at,
            }),
          );
      }),
    );
    return perRegion.flat();
  }

  async createSSHKey(
    name: string,
    publicKey: string,
  ): Promise<SSHKeyCreationResult> {
    const svc = await this.delegate();
    return svc.createSSHKey(name, publicKey);
  }

  // ── Private networks (VNets) via Neutron ──

  async createVNet(config: CreateVNetConfig): Promise<VNetCreationResult> {
    const client = await this.client();
    // createVNet() takes no region hint of its own — it always uses the
    // client's default region, so steer that from the subnet's zone.
    const region = config.subnets?.[0]?.networkZone;
    if (region) client.setDefaultRegion(region);
    const svc = new InfraOvhProviderService(this.configService, client);
    const result = await svc.createVNet(config);
    const resolvedRegion = region ?? (await client.resolveNetworkRegion());
    await Promise.all(
      result.subnets.map((subnet) =>
        client
          .clearSubnetGateway(resolvedRegion, subnet.id)
          .catch((e) =>
            this.logger.warn(
              `Failed to clear gateway on subnet ${subnet.id}: ${String(e)} — the node may pick up a second default route via this VNet.`,
            ),
          ),
      ),
    );
    return result;
  }

  async listVNets(): Promise<VNetDetails[]> {
    const svc = await this.delegate();
    return svc.listVNets();
  }

  async getVNet(vnetId: string): Promise<VNetDetails | null> {
    const svc = await this.delegate();
    return svc.getVNet(vnetId);
  }

  async deleteVNet(vnetId: string): Promise<VNetDeletionResult> {
    const svc = await this.delegate();
    return svc.deleteVNet(vnetId);
  }

  async addSubnet(config: AddSubnetConfig): Promise<{ actionId?: number }> {
    const svc = await this.delegate();
    return svc.addSubnet(config);
  }

  async deleteSubnet(
    config: DeleteSubnetConfig,
  ): Promise<{ actionId?: number }> {
    const svc = await this.delegate();
    return svc.deleteSubnet(config);
  }

  async attachServerToVNet(
    config: AttachServerToVNetConfig,
  ): Promise<ServerVNetAttachmentResult> {
    const svc = await this.delegate();
    return svc.attachServerToVNet(config);
  }

  async detachServerFromVNet(
    config: DetachServerFromVNetConfig,
  ): Promise<{ actionId?: number }> {
    const svc = await this.delegate();
    return svc.detachServerFromVNet(config);
  }
}

/**
 * @flui-cloud/infra declares its own CloudProvider enum (nominally distinct
 * from Flui's, even though the values overlap) — its ServerResponseDto.provider
 * is typed against that enum, not ours. Re-stamp it with the local enum value
 * so the DTO satisfies flui-core's own ServerResponseDto type.
 */
function toLocalServerDto<T extends { provider: unknown }>(
  s: T,
): Omit<T, 'provider'> & { provider: CloudProvider } {
  return { ...s, provider: CloudProvider.OVH };
}

/**
 * The rest of Flui passes a Hetzner-style hyphenated slug (e.g.
 * 'ubuntu-24.04') as the default OS image for every provider. OVH's Glance
 * images are matched by @flui-cloud/infra as whitespace-separated words
 * against the real display name ('Ubuntu 24.04') — a slug with no spaces
 * never matches. Convert 'distro-version' to 'Distro version'; anything that
 * doesn't look like that slug shape (already has a space, say) passes through.
 */
function toOvhImageName(image?: string): string | undefined {
  if (!image || !/^[a-z]+-\S/.test(image)) return image;
  const [distro, ...rest] = image.split('-');
  return `${distro[0].toUpperCase()}${distro.slice(1)} ${rest.join('-')}`;
}
