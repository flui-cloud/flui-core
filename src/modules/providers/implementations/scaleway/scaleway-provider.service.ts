import { Injectable, Logger, Inject } from '@nestjs/common';
import axios from 'axios';
import {
  ICloudProvider,
  CreateServerConfig,
  ServerCreationResult,
  ServerDeletionResult,
  SSHKeyCreationResult,
  SSHKeyDetails,
  SshKeyInfo,
  AttachedVolumeRequest,
  AttachedVolumeResult,
  ChangeServerTypeConfig,
  ProviderVolumeSummary,
} from '../../interfaces/cloud-provider.interface';
import { SSHKeyDto } from '../../../access/dto/ssh-key.dto';
import { ScalewayIamAdapter } from './scaleway-iam.adapter';
import { ICredentialProvider } from '../../interfaces/credential-provider.interface';
import { CloudProvider } from '../../enums/cloud-provider.enum';
import {
  CreateVNetConfig,
  VNetCreationResult,
  VNetDeletionResult,
  VNetDetails,
  AddSubnetConfig,
  DeleteSubnetConfig,
  AddRouteConfig,
  DeleteRouteConfig,
  AttachServerToVNetConfig,
  ServerVNetAttachmentResult,
  DetachServerFromVNetConfig,
} from '../../interfaces/network-provider.interface';
import { ScalewayVpcAdapter } from './scaleway-vpc.adapter';
import { InstanceEntity } from '../../../instances/entities/instance.entity';
import { InstanceStatus } from '../../../instances/entities/instance-status.enum';
import { InstanceType } from '../../../instances/entities/instance-type.enum';
import { ServerResponseDto } from 'src/modules/infrastructure/servers/dto/server-response.dto';
import { DeleteServerDto } from 'src/modules/infrastructure/servers/dto/delete-server.dto';
import { NodeSizeDto, NodeSizePriceDto } from '../../dto/node-size.dto';
import { LabelService } from '../../../common/services/label.service';
import {
  ScalewayInstancesAdapter,
  ScalewayInstanceServerType,
  INSTANCE_ZONES,
} from './scaleway-instances.adapter';
import {
  ScalewayBareMetalAdapter,
  BAREMETAL_ZONES,
} from './scaleway-baremetal.adapter';
import {
  ScalewayInstanceV1Server,
  ScalewayInstanceV1ServerStateEnum,
  ServerActionRequestActionEnum,
  CreateServerZoneEnum as InstancesCreateZone,
  CreateServerRequestVolumesVolumeKeyVolumeTypeEnum,
} from './generated/instances';
import {
  ScalewayBaremetalV1Server,
  ScalewayBaremetalV1ServerStatusEnum,
  ScalewayBaremetalV1Offer,
  ScalewayBaremetalV1IPVersionEnum,
  CreateServerZoneEnum as BaremetalCreateZone,
} from './generated/baremetal';

// Scaleway SBS (Scaleway Block Storage) pricing — not exposed by the instance types API, sourced from pricing page.
const SBS_5K_PRICE_PER_GB_MONTHLY = '0.0993'; // €/GB/month — SBS 5K standard IOPS (2025)

// Resource ID format: "instance:<zone>:<id>" or "baremetal:<zone>:<id>"
type ScalewayResourceId = {
  family: 'instance' | 'baremetal';
  zone: string;
  id: string;
};

@Injectable()
export class ScalewayProviderService implements ICloudProvider {
  private readonly logger = new Logger(ScalewayProviderService.name);

  constructor(
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
    private readonly labelService: LabelService,
    private readonly instancesAdapter: ScalewayInstancesAdapter,
    private readonly baremetalAdapter: ScalewayBareMetalAdapter,
    private readonly vpcAdapter: ScalewayVpcAdapter,
    private readonly iamAdapter: ScalewayIamAdapter,
  ) {}

  // ─── Flui shared storage Volumes (§14 of scaling doc) ────────────────────

  /**
   * Provision Block Storage (SBS) Volumes and attach them to a freshly created
   * instance. Uses raw axios calls because the Scaleway Block Storage API is
   * not in the generated client. Each volume is created, awaited, then
   * attached via the Instance API.
   *
   * Returns the device paths the bootstrap script will format/mount.
   * Convention for Scaleway SBS attached volumes: /dev/disk/by-id/scsi-0SCW_b_<volume-id>.
   */
  private async provisionSharedVolumes(args: {
    token: string;
    zone: string;
    requests: AttachedVolumeRequest[];
    tags: string[];
  }): Promise<AttachedVolumeResult[]> {
    const { token, zone, requests, tags } = args;
    const projectId = await this.iamAdapter.getDefaultProjectId();
    const baseUrl = 'https://api.scaleway.com';
    const headers = {
      'X-Auth-Token': token,
      'Content-Type': 'application/json',
    };

    const results: AttachedVolumeResult[] = [];
    for (const req of requests) {
      const sizeBytes = Math.max(1, req.sizeGb) * 1_000_000_000;
      this.logger.log(
        `[Scaleway] Creating SBS Volume ${req.name} (${req.sizeGb} GB) in zone ${zone}`,
      );

      let volumeId: string;
      try {
        const createResp = await axios.post(
          `${baseUrl}/block/v1/zones/${zone}/volumes`,
          {
            name: req.name,
            project_id: projectId,
            from_empty: { size: sizeBytes },
            perf_iops: 5000,
            tags: [...tags, 'flui-shared-storage'],
          },
          { headers, timeout: 30000 },
        );
        volumeId = createResp.data?.id as string;
        if (!volumeId) {
          throw new Error(
            `SBS Volume create returned no id (response: ${JSON.stringify(createResp.data)})`,
          );
        }
        this.logger.log(
          `[Scaleway] SBS Volume create accepted, id=${volumeId} status=${createResp.data?.status}`,
        );
      } catch (err: any) {
        const detail = err.response?.data
          ? JSON.stringify(err.response.data)
          : err.message;
        throw new Error(
          `SBS Volume create failed for ${req.name} (zone ${zone}): ${detail}`,
        );
      }

      const start = Date.now();
      const timeoutMs = 60_000;
      let ready = false;
      while (Date.now() - start < timeoutMs) {
        try {
          const statusResp = await axios.get(
            `${baseUrl}/block/v1/zones/${zone}/volumes/${volumeId}`,
            { headers, timeout: 15000 },
          );
          const status = statusResp.data.status as string;
          if (status === 'available') {
            ready = true;
            break;
          }
          if (status === 'error') {
            throw new Error(`SBS Volume ${volumeId} reported error status`);
          }
        } catch (err: any) {
          if (err.response?.status === 404) {
            this.logger.warn(
              `[Scaleway] SBS Volume ${volumeId} GET 404 (eventual consistency), retrying`,
            );
          } else {
            const detail = err.response?.data
              ? JSON.stringify(err.response.data)
              : err.message;
            throw new Error(
              `SBS Volume ${volumeId} status poll failed: ${detail}`,
            );
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!ready) {
        throw new Error(
          `SBS Volume ${volumeId} did not become available within ${timeoutMs / 1000}s`,
        );
      }

      this.logger.log(
        `[Scaleway] ✅ SBS Volume ${volumeId} (${req.sizeGb} GB) ready for inline attach`,
      );
      results.push({
        volumeId,
        devicePath: `/dev/disk/by-id/scsi-0SCW_b_${volumeId}`,
        sizeGb: req.sizeGb,
      });
    }

    return results;
  }

  private async deleteSharedVolume(args: {
    token: string;
    zone: string;
    volumeId: string;
  }): Promise<void> {
    const { token, zone, volumeId } = args;
    const baseUrl = 'https://api.scaleway.com';
    const headers = {
      'X-Auth-Token': token,
      'Content-Type': 'application/json',
    };
    try {
      await axios.delete(
        `${baseUrl}/block/v1/zones/${zone}/volumes/${volumeId}`,
        { headers, timeout: 15000 },
      );
    } catch (err: any) {
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      this.logger.warn(
        `[Scaleway] Failed to cleanup SBS Volume ${volumeId} after instance failure: ${detail}`,
      );
    }
  }

  // ─── Resource ID helpers ───────────────────────────────────────────────────

  private buildInstanceResourceId(zone: string, id: string): string {
    return `instance:${zone}:${id}`;
  }

  private buildBaremetalResourceId(zone: string, id: string): string {
    return `baremetal:${zone}:${id}`;
  }

  private parseResourceId(resourceId: string): ScalewayResourceId | null {
    const parts = resourceId.split(':');
    if (parts.length !== 3) return null;
    const [family, zone, id] = parts;
    if (family !== 'instance' && family !== 'baremetal') return null;
    return { family: family, zone, id };
  }

  // ─── Label / tag helpers ───────────────────────────────────────────────────

  private labelsToTags(labels: Record<string, string>): string[] {
    return Object.entries(labels).map(([k, v]) => `${k}=${v}`);
  }

  private tagsToLabels(tags: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const tag of tags) {
      const eqIdx = tag.indexOf('=');
      if (eqIdx > 0) {
        result[tag.substring(0, eqIdx)] = tag.substring(eqIdx + 1);
      } else {
        result[tag] = '';
      }
    }
    return result;
  }

  // ─── Status mapping ────────────────────────────────────────────────────────

  private mapInstanceStatus(
    state: ScalewayInstanceV1ServerStateEnum,
  ): InstanceStatus {
    switch (state) {
      case ScalewayInstanceV1ServerStateEnum.Running:
        return InstanceStatus.RUNNING;
      case ScalewayInstanceV1ServerStateEnum.Stopped:
      case ScalewayInstanceV1ServerStateEnum.StoppedInPlace:
        return InstanceStatus.STOPPED;
      case ScalewayInstanceV1ServerStateEnum.Starting:
        return InstanceStatus.STARTING;
      case ScalewayInstanceV1ServerStateEnum.Stopping:
        return InstanceStatus.STOPPING;
      case ScalewayInstanceV1ServerStateEnum.Locked:
        return InstanceStatus.ERROR;
      default:
        return InstanceStatus.UNKNOWN;
    }
  }

  private mapBaremetalStatus(
    status: ScalewayBaremetalV1ServerStatusEnum,
  ): InstanceStatus {
    switch (status) {
      case ScalewayBaremetalV1ServerStatusEnum.Ready:
        return InstanceStatus.RUNNING;
      case ScalewayBaremetalV1ServerStatusEnum.Stopped:
        return InstanceStatus.STOPPED;
      case ScalewayBaremetalV1ServerStatusEnum.Starting:
        return InstanceStatus.STARTING;
      case ScalewayBaremetalV1ServerStatusEnum.Stopping:
        return InstanceStatus.STOPPING;
      case ScalewayBaremetalV1ServerStatusEnum.Delivering:
      case ScalewayBaremetalV1ServerStatusEnum.Ordered:
      case ScalewayBaremetalV1ServerStatusEnum.Resetting:
        return InstanceStatus.PROVISIONING;
      case ScalewayBaremetalV1ServerStatusEnum.Deleting:
        return InstanceStatus.DELETING;
      case ScalewayBaremetalV1ServerStatusEnum.Error:
      case ScalewayBaremetalV1ServerStatusEnum.Locked:
        return InstanceStatus.ERROR;
      case ScalewayBaremetalV1ServerStatusEnum.Migrating:
        return InstanceStatus.MIGRATING;
      default:
        return InstanceStatus.UNKNOWN;
    }
  }

  // ─── DTO mappers ───────────────────────────────────────────────────────────

  private mapInstanceServerToEntity(
    server: ScalewayInstanceV1Server,
    zone: string,
    typeMap?: Map<string, ScalewayInstanceServerType & { name: string }>,
  ): InstanceEntity {
    const entity = new InstanceEntity();
    entity.name = server.name || '';
    entity.displayName = server.name || '';
    entity.provider = CloudProvider.SCALEWAY;
    entity.providerId = this.buildInstanceResourceId(zone, server.id);
    entity.status = this.mapInstanceStatus(server.state);
    entity.type = InstanceType.VM;
    entity.dataCenter = zone;
    entity.region = zone;
    entity.regionName = zone;

    const typeSpec = server.commercial_type
      ? typeMap?.get(server.commercial_type)
      : undefined;
    entity.cpuCores = typeSpec?.ncpus ?? 0;
    entity.ramMb = typeSpec?.ram ? Math.round(typeSpec.ram / 1e6) : 0;
    const volMax = typeSpec?.volumes_constraint?.max_size ?? 0;
    entity.diskMb = volMax > 0 ? Math.round(volMax / 1e6) : 0;
    entity.osType = null;
    entity.defaultUser = 'root';
    entity.additionalIps = [];

    const publicIps = server.public_ips || [];
    const firstIp = publicIps[0];
    entity.ipConfig = {
      v4: firstIp
        ? { ip: firstIp.address || '', gateway: '', netmaskCidr: 32 }
        : undefined,
    };

    const instanceTags = server.tags || [];
    entity.metadata = {
      scalewayId: server.id,
      zone,
      commercialType: server.commercial_type,
      tags: instanceTags,
      labels: this.tagsToLabels(instanceTags),
      arch: server.arch,
      created: server.creation_date,
    };

    entity.userId = '';
    return entity;
  }

  private mapBaremetalServerToEntity(
    server: ScalewayBaremetalV1Server,
    zone: string,
    offerMap?: Map<string, ScalewayBaremetalV1Offer>,
  ): InstanceEntity {
    const entity = new InstanceEntity();
    entity.name = server.name || '';
    entity.displayName = server.name || '';
    entity.provider = CloudProvider.SCALEWAY;
    entity.providerId = this.buildBaremetalResourceId(zone, server.id);
    entity.status = this.mapBaremetalStatus(server.status);
    entity.type = InstanceType.DEDICATED;
    entity.dataCenter = zone;
    entity.region = zone;
    entity.regionName = zone;

    const offer = server.offer_id ? offerMap?.get(server.offer_id) : undefined;
    entity.cpuCores = (offer?.cpus ?? []).reduce(
      (s, c) => s + (c.core_count ?? 0),
      0,
    );
    const totalRamBytes = (offer?.memories ?? []).reduce(
      (s, m) => s + (m.capacity ?? 0),
      0,
    );
    entity.ramMb = totalRamBytes > 0 ? Math.round(totalRamBytes / 1e6) : 0;
    const totalDiskBytes = (offer?.disks ?? []).reduce(
      (s, d) => s + (d.capacity ?? 0),
      0,
    );
    entity.diskMb = totalDiskBytes > 0 ? Math.round(totalDiskBytes / 1e6) : 0;
    entity.osType = null;
    entity.defaultUser = 'root';
    entity.additionalIps = [];

    const ips = server.ips || [];
    const ipv4 = ips.find(
      (ip) => ip.version === ScalewayBaremetalV1IPVersionEnum.Ipv4,
    );
    const ipv6 = ips.find(
      (ip) => ip.version === ScalewayBaremetalV1IPVersionEnum.Ipv6,
    );
    entity.ipConfig = {
      v4: ipv4
        ? { ip: ipv4.address || '', gateway: '', netmaskCidr: 32 }
        : undefined,
      v6: ipv6
        ? { ip: ipv6.address || '', gateway: '', netmaskCidr: 64 }
        : undefined,
    };

    const baremetalTags = server.tags || [];
    entity.metadata = {
      scalewayId: server.id,
      zone,
      offerId: server.offer_id,
      offerName: server.offer_name,
      tags: baremetalTags,
      labels: this.tagsToLabels(baremetalTags),
      created: server.created_at,
    };

    entity.userId = '';
    return entity;
  }

  private mapInstanceServerToDto(
    server: ScalewayInstanceV1Server,
    zone: string,
  ): ServerResponseDto {
    const publicIps = server.public_ips || [];
    const firstPublicIp = publicIps[0]?.address;
    const labels = this.tagsToLabels(server.tags || []);
    // Resolve the IPAM-assigned IP from the first private NIC (if any). The
    // Scaleway server payload exposes the address either inline on the NIC or
    // via the top-level private_ip field (legacy IPAM).
    const privateNics = (server as any).private_nics ?? [];
    const firstNicIp =
      privateNics[0]?.private_ip ?? (server as any).private_ip ?? null;

    return {
      id: this.buildInstanceResourceId(zone, server.id),
      name: server.name || '',
      provider: CloudProvider.SCALEWAY,
      provider_resource_id: this.buildInstanceResourceId(zone, server.id),
      server_type: server.commercial_type || '',
      location: zone,
      status: server.state || 'unknown',
      public_ip: firstPublicIp || null,
      private_ip: firstNicIp,
      created_at: server.creation_date
        ? new Date(server.creation_date)
        : new Date(),
      updated_at: server.modification_date
        ? new Date(server.modification_date)
        : new Date(),
      lastSyncAt: new Date(),
      labels: this.labelService.fromRecord(labels),
    };
  }

  private mapBaremetalServerToDto(
    server: ScalewayBaremetalV1Server,
    zone: string,
  ): ServerResponseDto {
    const ips = server.ips || [];
    const ipv4 = ips.find(
      (ip) => ip.version === ScalewayBaremetalV1IPVersionEnum.Ipv4,
    );
    const labels = this.tagsToLabels(server.tags || []);

    return {
      id: this.buildBaremetalResourceId(zone, server.id),
      name: server.name || '',
      provider: CloudProvider.SCALEWAY,
      provider_resource_id: this.buildBaremetalResourceId(zone, server.id),
      server_type: server.offer_name || server.offer_id || '',
      location: zone,
      status: server.status || 'unknown',
      public_ip: ipv4?.address || null,
      private_ip: null,
      created_at: server.created_at ? new Date(server.created_at) : new Date(),
      updated_at: server.updated_at ? new Date(server.updated_at) : new Date(),
      lastSyncAt: new Date(),
      labels: this.labelService.fromRecord(labels),
    };
  }

  // ─── ICloudProvider required methods ──────────────────────────────────────

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const token = await this.credentialProvider.getActiveApiToken(
        CloudProvider.SCALEWAY,
      );
      await this.instancesAdapter.listServers(
        token,
        InstancesCreateZone.FrPar1,
      );
      return { success: true };
    } catch (error) {
      this.logger.error('Scaleway connection test failed', error.message);
      return { success: false, error: error.message };
    }
  }

  async listInstances(filters?: any): Promise<InstanceEntity[]> {
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );
    const entities: InstanceEntity[] = [];

    // Pre-fetch server types per zone for hardware spec enrichment
    const instanceTypeMapsByZone = new Map<
      string,
      Map<string, ScalewayInstanceServerType & { name: string }>
    >();
    await Promise.allSettled(
      INSTANCE_ZONES.map(async (zone) => {
        try {
          const types = await this.instancesAdapter.listServerTypes(
            token,
            zone,
          );
          instanceTypeMapsByZone.set(
            zone,
            new Map(types.map((t) => [t.name, t])),
          );
        } catch {
          // non-fatal: hardware specs will be 0 for this zone
        }
      }),
    );

    const instanceResults = await Promise.allSettled(
      INSTANCE_ZONES.map(async (zone) => {
        const servers = await this.instancesAdapter.listServers(token, zone);
        const typeMap = instanceTypeMapsByZone.get(zone);
        // Resolve IPAM-allocated private IPs in parallel so the entity reflects
        // the VNet attachment. Without this, additionalIps stays empty and the
        // Dashboard /instances view shows only the public IP.
        return Promise.all(
          servers.map(async (s) => {
            const entity = this.mapInstanceServerToEntity(s, zone, typeMap);
            try {
              const privateIp =
                await this.instancesAdapter.getInstancePrivateIp(
                  token,
                  zone,
                  s,
                );
              if (privateIp) {
                entity.additionalIps = [
                  ...(entity.additionalIps ?? []),
                  privateIp,
                ];
                entity.metadata = {
                  ...entity.metadata,
                  privateIp,
                };
              }
            } catch {
              // non-fatal: keep the entity without the private IP
            }
            return entity;
          }),
        );
      }),
    );

    for (const result of instanceResults) {
      if (result.status === 'fulfilled') {
        if (filters?.clusterId) {
          const clusterTag = `flui-cluster-id=${filters.clusterId}`;
          entities.push(
            ...result.value.filter(
              (e) =>
                Array.isArray(e.metadata?.tags) &&
                e.metadata.tags.includes(clusterTag),
            ),
          );
        } else {
          entities.push(...result.value);
        }
      }
    }

    // Pre-fetch baremetal offers per zone for hardware spec enrichment
    const baremetalOfferMapsByZone = new Map<
      string,
      Map<string, ScalewayBaremetalV1Offer>
    >();
    await Promise.allSettled(
      BAREMETAL_ZONES.map(async (zone) => {
        try {
          const offers = await this.baremetalAdapter.listOffers(token, zone);
          baremetalOfferMapsByZone.set(
            zone,
            new Map(offers.filter((o) => o.id).map((o) => [o.id, o])),
          );
        } catch {
          // non-fatal
        }
      }),
    );

    const baremetalResults = await Promise.allSettled(
      BAREMETAL_ZONES.map(async (zone) => {
        const servers = await this.baremetalAdapter.listServers(token, zone);
        const offerMap = baremetalOfferMapsByZone.get(zone);
        return servers.map((s) =>
          this.mapBaremetalServerToEntity(s, zone, offerMap),
        );
      }),
    );

    for (const result of baremetalResults) {
      if (result.status === 'fulfilled') {
        if (filters?.clusterId) {
          const clusterTag = `flui-cluster-id=${filters.clusterId}`;
          entities.push(
            ...result.value.filter(
              (e) =>
                Array.isArray(e.metadata?.tags) &&
                e.metadata.tags.includes(clusterTag),
            ),
          );
        } else {
          entities.push(...result.value);
        }
      }
    }

    return entities;
  }

  async listServersAsDto(): Promise<ServerResponseDto[]> {
    try {
      const token = await this.credentialProvider.getActiveApiToken(
        CloudProvider.SCALEWAY,
      );
      const dtos: ServerResponseDto[] = [];

      const instanceResults = await Promise.allSettled(
        INSTANCE_ZONES.map(async (zone) => {
          const servers = await this.instancesAdapter.listServers(token, zone);
          return Promise.all(
            servers.map(async (s) => {
              const dto = this.mapInstanceServerToDto(s, zone);
              if (!dto.private_ip) {
                const ipv4 = await this.instancesAdapter.getInstancePrivateIp(
                  token,
                  zone,
                  s,
                );
                if (ipv4) dto.private_ip = ipv4;
              }
              return dto;
            }),
          );
        }),
      );
      for (const r of instanceResults) {
        if (r.status === 'fulfilled') dtos.push(...r.value);
      }

      const baremetalResults = await Promise.allSettled(
        BAREMETAL_ZONES.map(async (zone) => {
          const servers = await this.baremetalAdapter.listServers(token, zone);
          return servers.map((s) => this.mapBaremetalServerToDto(s, zone));
        }),
      );
      for (const r of baremetalResults) {
        if (r.status === 'fulfilled') dtos.push(...r.value);
      }

      return dtos;
    } catch (error) {
      this.logger.error('Failed to list Scaleway servers', error.message);
      return [];
    }
  }

  async getServerDetailsAsDto(
    serverId: string,
  ): Promise<ServerResponseDto | null> {
    const parsed = this.parseResourceId(serverId);
    if (!parsed) {
      this.logger.warn(`Invalid Scaleway resource ID: ${serverId}`);
      return null;
    }

    try {
      const token = await this.credentialProvider.getActiveApiToken(
        CloudProvider.SCALEWAY,
      );

      if (parsed.family === 'instance') {
        const server = await this.instancesAdapter.getServer(
          token,
          parsed.zone,
          parsed.id,
        );
        if (!server) return null;
        return this.mapInstanceServerToDto(server, parsed.zone);
      } else {
        const server = await this.baremetalAdapter.getServer(
          token,
          parsed.zone,
          parsed.id,
        );
        if (!server) return null;
        return this.mapBaremetalServerToDto(server, parsed.zone);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to get Scaleway server details for ${serverId}`,
        error.message,
      );
      return null;
    }
  }

  async createServer(
    config: CreateServerConfig,
  ): Promise<ServerCreationResult> {
    this.logger.log(`Creating Scaleway server: ${config.name}`);

    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );
    const labels = config.labels
      ? this.labelService.toRecord(config.labels)
      : {};
    const tags = this.labelsToTags(labels);

    // Determine if this is a baremetal offer by checking the offer_id prefix or server_type
    // Convention: baremetal server_types start with "EM-" (Elastic Metal) or "BM-"
    const serverType = config.server_type || '';
    const isBaremetal =
      serverType.toUpperCase().startsWith('EM-') ||
      serverType.toUpperCase().startsWith('BM-');

    // Scaleway Instances require a zone (e.g. 'fr-par-1'), not a region (e.g. 'fr-par').
    // If the caller passes a region, append '-1' to use the first/default zone.
    const rawLocation = config.location || 'fr-par-1';
    const zone = (
      /^[a-z]{2}-[a-z]{3}$/.test(rawLocation) ? `${rawLocation}-1` : rawLocation
    ) as BaremetalCreateZone;

    if (isBaremetal) {
      return this.createBaremetalServer(token, config, zone, tags);
    } else {
      return this.createInstanceServer(
        token,
        config,
        zone as unknown as InstancesCreateZone,
        tags,
      );
    }
  }

  private async createInstanceServer(
    token: string,
    config: CreateServerConfig,
    zone: InstancesCreateZone,
    tags: string[],
  ): Promise<ServerCreationResult> {
    // Resolve the root volume:
    //   - For local-SSD types (DEV1-*, GP1-*, PLAY2-*, ...) Scaleway only allocates
    //     the per-type minimum unless we explicitly size the boot volume. Default to
    //     the type's `volumes_constraint.max_size` so the user actually gets the
    //     storage already included in the price (e.g. DEV1-M = 40 GB).
    //   - For network-storage-only types (PRO2-*, ENT1-*) we must create an
    //     SBS volume; user must pass `diskSizeGb`.
    const commercialType = (config.server_type || 'DEV1-S').toUpperCase();
    let typeSpec: (ScalewayInstanceServerType & { name: string }) | undefined;
    try {
      const types = await this.instancesAdapter.listServerTypes(token, zone);
      typeSpec = types.find((t) => t.name === commercialType);
    } catch (err) {
      this.logger.warn(
        `[Scaleway] Failed to fetch instance type spec for ${commercialType}: ${(err as Error).message}`,
      );
    }

    const lssdMax =
      (typeSpec as any)?.per_volume_constraint?.l_ssd?.max_size ?? 0;
    const isLocalSsd = lssdMax > 0;
    const typeMaxSize = typeSpec?.volumes_constraint?.max_size ?? 0;

    const volumes: Record<
      string,
      { volume_type: string; size: number; boot: boolean; id?: string }
    > = {};

    let rootBytes = 0;
    let volumeType: string | undefined;
    if (config.diskSizeGb && config.diskSizeGb > 0) {
      rootBytes = config.diskSizeGb * 1_000_000_000;
      volumeType = isLocalSsd
        ? CreateServerRequestVolumesVolumeKeyVolumeTypeEnum.LSsd
        : CreateServerRequestVolumesVolumeKeyVolumeTypeEnum.SbsVolume;
    } else if (isLocalSsd && typeMaxSize > 0) {
      rootBytes = typeMaxSize;
      volumeType = CreateServerRequestVolumesVolumeKeyVolumeTypeEnum.LSsd;
    }

    if (rootBytes > 0 && volumeType) {
      volumes['0'] = {
        volume_type: volumeType,
        size: rootBytes,
        boot: true,
      };
      this.logger.log(
        `[Scaleway] Creating instance ${config.name} (${commercialType}) ` +
          `with root volume: ${Math.round(rootBytes / 1e9)} GB ${volumeType} ` +
          `(${config.diskSizeGb ? 'user-specified' : 'type default max_size'})`,
      );
    } else if (!isLocalSsd) {
      this.logger.warn(
        `[Scaleway] ${commercialType} requires network storage but diskSizeGb was not set — Scaleway will reject the request`,
      );
    }

    const projectId = await this.iamAdapter.getDefaultProjectId();

    // Pre-provision Flui-managed extra Volumes (§14 of scaling doc) BEFORE
    // creating the instance. Once available, attach them inline via the
    // createServer `volumes` dict (id + volume_type + boot:false). This is
    // the documented Scaleway pattern and avoids the post-create attach
    // race that previously left instances unable to power on.
    let preprovisionedVolumes: AttachedVolumeResult[] = [];
    if (config.attachedVolumes && config.attachedVolumes.length > 0) {
      preprovisionedVolumes = await this.provisionSharedVolumes({
        token,
        zone: zone as unknown as string,
        requests: config.attachedVolumes,
        tags,
      });
      let nextKey = 1;
      while (volumes[String(nextKey)]) nextKey++;
      for (const v of preprovisionedVolumes) {
        volumes[String(nextKey)] = {
          id: v.volumeId,
          volume_type:
            CreateServerRequestVolumesVolumeKeyVolumeTypeEnum.SbsVolume,
          boot: false,
        } as { volume_type: string; size: number; boot: boolean; id?: string };
        nextKey++;
      }
      this.logger.log(
        `[Scaleway] Including ${preprovisionedVolumes.length} pre-created SBS volume(s) in createServer payload`,
      );
    }

    // Extract the security group UUID from the first firewall ID (format: "<zone>:<sgId>")
    // Passing security_group at creation time is the recommended approach — it ensures the
    // firewall rules are applied before the instance boots for the first time.
    let securityGroupId: string | undefined;
    if (config.firewalls && config.firewalls.length > 0) {
      const firstFw = config.firewalls[0];
      const colonIdx = firstFw.indexOf(':');
      if (colonIdx > 0) {
        securityGroupId = firstFw.substring(colonIdx + 1);
        this.logger.log(
          `[Scaleway] Attaching security group ${securityGroupId} at instance creation time (from firewall ${firstFw})`,
        );
      } else {
        this.logger.warn(
          `[Scaleway] Cannot parse firewall ID "${firstFw}" — expected "<zone>:<sgId>", security group will NOT be attached at creation`,
        );
      }
    } else {
      this.logger.log(
        `[Scaleway] No firewalls configured for instance ${config.name} — creating without security group`,
      );
    }

    let server: ScalewayInstanceV1Server;
    try {
      server = await this.instancesAdapter.createServer(token, zone, {
        name: config.name,
        commercial_type: config.server_type || 'DEV1-S',
        image: 'ubuntu_noble',
        tags,
        project: projectId,
        volumes: Object.keys(volumes).length > 0 ? (volumes as any) : undefined,
        security_group: securityGroupId,
      });
    } catch (err: any) {
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      this.logger.error(
        `[Scaleway] createServer failed (zone=${zone}, type=${config.server_type}, volumes-keys=${Object.keys(volumes).join(',')}): ${detail}`,
      );
      for (const v of preprovisionedVolumes) {
        await this.deleteSharedVolume({
          token,
          zone: zone as unknown as string,
          volumeId: v.volumeId,
        });
      }
      throw new Error(
        `Scaleway createServer failed: ${detail} (volumes payload keys: ${Object.keys(volumes).join(',')})`,
      );
    }

    // Set cloud-init user data before powering on
    if (server.id && config.user_data) {
      this.logger.log(
        `[Scaleway] Setting user_data (cloud-init) on instance ${server.id} (zone: ${zone}, size: ${config.user_data.length} bytes)`,
      );
      this.logger.debug(
        `[Scaleway] cloud-init preview (first 300 chars): ${config.user_data.substring(0, 300)}`,
      );
      try {
        await this.instancesAdapter.setUserData(
          token,
          zone,
          server.id,
          config.user_data,
        );
        this.logger.log(
          `[Scaleway] ✅ user_data set successfully on instance ${server.id}`,
        );
      } catch (err) {
        const errDetails = err.response?.data
          ? ` — ${JSON.stringify(err.response.data)}`
          : '';
        this.logger.error(
          `[Scaleway] ❌ Failed to set user_data for instance ${server.id}: ${err.message}${errDetails}`,
        );
      }
    } else if (server.id && !config.user_data) {
      this.logger.warn(
        `[Scaleway] ⚠️  No user_data provided for instance ${server.id} — cloud-init will NOT run`,
      );
    }

    // SBS volumes were pre-provisioned and attached inline via the
    // createServer `volumes` dict (see above). Nothing extra to do here.
    const attachedVolumesResult: AttachedVolumeResult[] = preprovisionedVolumes;

    // Power on the server (instances start stopped by default after create)
    if (
      server.id &&
      server.state !== ScalewayInstanceV1ServerStateEnum.Running
    ) {
      this.logger.log(
        `[Scaleway] Powering on instance ${server.id} (current state: ${server.state})`,
      );
      try {
        await this.instancesAdapter.serverAction(
          token,
          zone,
          server.id,
          ServerActionRequestActionEnum.Poweron,
        );
        this.logger.log(
          `[Scaleway] ✅ Power-on action sent for instance ${server.id}`,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to power on instance ${server.id}: ${err.message}`,
        );
      }
    }

    // Verify/confirm security group attachment (first one was set at creation time, extras via update)
    if (config.firewalls && config.firewalls.length > 0 && server.id) {
      // Log current security group on the created server for verification
      const createdSg = (server as any).security_group;
      this.logger.log(
        `[Scaleway] Instance ${server.id} security_group after creation: ${JSON.stringify(createdSg)}`,
      );

      for (let i = 0; i < config.firewalls.length; i++) {
        const firewallId = config.firewalls[i];
        const parts = firewallId.split(':');
        if (parts.length === 2) {
          const [fwZone, sgId] = parts;
          if (i === 0 && securityGroupId === sgId) {
            // Already set at creation time — just log confirmation
            this.logger.log(
              `[Scaleway] ✅ Security group ${sgId} was set at instance creation time (no extra call needed)`,
            );
            continue;
          }
          // Additional firewalls (index > 0) applied via updateServer
          try {
            await this.instancesAdapter.applySecurityGroupToServer(
              token,
              fwZone as unknown as InstancesCreateZone,
              server.id,
              sgId,
            );
            this.logger.log(
              `[Scaleway] ✅ Additional security group ${sgId} attached to instance ${server.id}`,
            );
          } catch (err) {
            const responseDetails = err.response?.data
              ? ` — response: ${JSON.stringify(err.response.data)}`
              : '';
            this.logger.error(
              `[Scaleway] ❌ Failed to attach security group ${sgId} to instance ${server.id}: ${err.message}${responseDetails}`,
            );
          }
        } else {
          this.logger.warn(
            `[Scaleway] Skipping firewall with unexpected format: "${firewallId}" (expected "<zone>:<sgId>")`,
          );
        }
      }
    } else if (!server.id) {
      this.logger.warn(
        `[Scaleway] Cannot attach security groups — server.id is missing after creation`,
      );
    }

    // Newly-created instances don't have a public IP until they finish booting.
    // Poll getServer until public_ips is populated (~30-60s typical, 5 min cap).
    let ipAddress: string | undefined =
      server.public_ips?.[0]?.address ?? undefined;
    let finalState = server.state;
    let privateIp: string | undefined = (server as any).private_ip ?? undefined;
    if (server.id && !ipAddress) {
      const startedAt = Date.now();
      const timeoutMs = 5 * 60_000;
      while (Date.now() - startedAt < timeoutMs) {
        await new Promise((r) => setTimeout(r, 5_000));
        try {
          const fresh = await this.instancesAdapter.getServer(
            token,
            zone,
            server.id,
          );
          finalState = fresh.state ?? finalState;
          privateIp = (fresh as any).private_ip ?? privateIp;
          const ip = fresh.public_ips?.[0]?.address;
          if (ip) {
            ipAddress = ip;
            break;
          }
        } catch (err) {
          this.logger.warn(
            `[Scaleway] Poll for instance ${server.id} IP failed: ${(err as Error).message}`,
          );
        }
      }
      if (!ipAddress) {
        throw new Error(
          `Scaleway instance ${server.id} did not receive a public IP within 5 minutes`,
        );
      }
      this.logger.log(
        `[Scaleway] Instance ${server.id} got public IP ${ipAddress} (state: ${finalState})`,
      );
    }

    // Attach to Private Network when the caller passed `networks`.
    // Each entry is a vnetId in our canonical "<region>:<uuid>" form; we strip
    // the region prefix because Scaleway's createPrivateNIC takes the bare UUID.
    if (server.id && config.networks && config.networks.length > 0) {
      for (const networkRef of config.networks) {
        const pnId = this.vpcAdapter.parseVnetId(networkRef).id;
        try {
          await this.instancesAdapter.attachToPrivateNetwork(
            token,
            zone,
            server.id,
            pnId,
          );
        } catch (err) {
          this.logger.error(
            `[Scaleway] Failed to attach instance ${server.id} to private network ${pnId}: ${(err as Error).message}`,
          );
          throw err;
        }
      }

      // Poll once more so the IPAM-assigned private IP propagates onto the
      // server payload before we return. Scaleway's NICs only carry the IP
      // ID (`ipam_ip_ids`) — the actual address must be resolved via IPAM.
      const startedAt = Date.now();
      const timeoutMs = 90_000;
      while (Date.now() - startedAt < timeoutMs) {
        await new Promise((r) => setTimeout(r, 5_000));
        try {
          const fresh = await this.instancesAdapter.getServer(
            token,
            zone,
            server.id,
          );
          const ipv4 = await this.instancesAdapter.getInstancePrivateIp(
            token,
            zone,
            fresh,
          );
          if (ipv4) {
            privateIp = ipv4;
            break;
          }
        } catch {
          // ignore transient errors during polling
        }
      }
      if (privateIp) {
        this.logger.log(
          `[Scaleway] Instance ${server.id} got private IP ${privateIp} from IPAM`,
        );
      } else {
        this.logger.warn(
          `[Scaleway] Instance ${server.id} attached to VNet but private IP not yet visible after ${timeoutMs / 1000}s`,
        );
      }
    }

    return {
      serverId: this.buildInstanceResourceId(zone, server.id),
      ipAddress,
      privateIp,
      status: finalState || 'unknown',
      attachedVolumes:
        attachedVolumesResult.length > 0 ? attachedVolumesResult : undefined,
    } as ServerCreationResult;
  }

  private async createBaremetalServer(
    token: string,
    config: CreateServerConfig,
    zone: BaremetalCreateZone,
    tags: string[],
  ): Promise<ServerCreationResult> {
    const server = await this.baremetalAdapter.createServer(token, zone, {
      name: config.name,
      offer_id: config.server_type || '',
      description: config.name,
      tags,
      install:
        config.ssh_keys && config.ssh_keys.length > 0
          ? {
              os_id: config.image || '',
              hostname: config.name,
              ssh_key_ids: config.ssh_keys,
            }
          : undefined,
      user_data: config.user_data ? { value: config.user_data } : undefined,
    });

    const ips = server.ips || [];
    const ipv4 = ips.find(
      (ip) => ip.version === ScalewayBaremetalV1IPVersionEnum.Ipv4,
    );

    return {
      serverId: this.buildBaremetalResourceId(zone, server.id),
      ipAddress: ipv4?.address,
      status: server.status || 'unknown',
    };
  }

  async deleteServer(config: DeleteServerDto): Promise<ServerDeletionResult> {
    const parsed = this.parseResourceId(config.server_id);
    if (!parsed) {
      throw new Error(`Invalid Scaleway resource ID: ${config.server_id}`);
    }

    this.logger.log(`Deleting Scaleway server: ${config.server_id}`);
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );

    try {
      if (parsed.family === 'instance') {
        await this.instancesAdapter.deleteServer(token, parsed.zone, parsed.id);
      } else {
        await this.baremetalAdapter.deleteServer(token, parsed.zone, parsed.id);
      }

      return { message: `Server ${config.server_id} deletion initiated` };
    } catch (error) {
      if (error.response?.status === 404) {
        throw new Error(`Server ${config.server_id} not found`);
      }
      throw new Error(`Server deletion failed: ${error.message}`);
    }
  }

  async getServerStatus(serverId: string): Promise<string> {
    const parsed = this.parseResourceId(serverId);
    if (!parsed) return 'error';

    try {
      const token = await this.credentialProvider.getActiveApiToken(
        CloudProvider.SCALEWAY,
      );
      if (parsed.family === 'instance') {
        const server = await this.instancesAdapter.getServer(
          token,
          parsed.zone,
          parsed.id,
        );
        return server?.state || 'not-found';
      } else {
        const server = await this.baremetalAdapter.getServer(
          token,
          parsed.zone,
          parsed.id,
        );
        return server?.status || 'not-found';
      }
    } catch (error) {
      if (error.response?.status === 404) return 'not-found';
      return 'error';
    }
  }

  // ─── Optional methods ──────────────────────────────────────────────────────

  async powerOnServer(serverId: string): Promise<void> {
    const parsed = this.parseResourceId(serverId);
    if (!parsed) throw new Error(`Invalid resource ID: ${serverId}`);

    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );

    if (parsed.family === 'instance') {
      await this.instancesAdapter.serverAction(
        token,
        parsed.zone,
        parsed.id,
        ServerActionRequestActionEnum.Poweron,
      );
    } else {
      await this.baremetalAdapter.startServer(token, parsed.zone, parsed.id);
    }
  }

  async changeServerType(
    serverId: string,
    config: ChangeServerTypeConfig,
  ): Promise<{ actionId?: number }> {
    const parsed = this.parseResourceId(serverId);
    if (!parsed) throw new Error(`Invalid resource ID: ${serverId}`);

    if (parsed.family !== 'instance') {
      throw new Error(
        `changeServerType is not supported for Scaleway ${parsed.family} servers (bare-metal requires re-provisioning).`,
      );
    }

    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );
    this.logger.log(
      `[Scaleway] change commercial_type server=${parsed.id} → ${config.targetServerType} (zone=${parsed.zone})`,
    );

    await this.instancesAdapter.updateServerCommercialType(
      token,
      parsed.zone,
      parsed.id,
      config.targetServerType,
    );
    return {};
  }

  async expandVolume(
    volumeId: string,
    newSizeGb: number,
  ): Promise<{ actionId?: number }> {
    // Scaleway SBS resize requires a zone-scoped PATCH against the Block API.
    // The orchestration layer must pass volumeId as `<zone>:<uuid>` so we can
    // route the call without an additional lookup. Cluster-managed SBS
    // volumes always live in the same zone as the master node, which the
    // caller already knows from ClusterEntity.
    const colon = volumeId.indexOf(':');
    if (colon < 0) {
      throw new Error(
        `Scaleway expandVolume requires volumeId in "<zone>:<uuid>" format (got "${volumeId}")`,
      );
    }
    const zone = volumeId.slice(0, colon);
    const id = volumeId.slice(colon + 1);
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );
    const baseUrl = 'https://api.scaleway.com';
    const headers = { 'X-Auth-Token': token } as Record<string, string>;
    const sizeBytes = newSizeGb * 1_000_000_000;
    this.logger.log(
      `[Scaleway] SBS resize volume=${id} zone=${zone} → ${newSizeGb} GB`,
    );
    try {
      await axios.patch(
        `${baseUrl}/block/v1/zones/${zone}/volumes/${id}`,
        { size: sizeBytes },
        { headers, timeout: 30000 },
      );
      return {};
    } catch (err: any) {
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      throw new Error(
        `Scaleway SBS resize failed for ${id} (zone ${zone}): ${detail}`,
      );
    }
  }

  async detachVolume(volumeId: string): Promise<{ actionId?: number }> {
    const parsed = this.parseVolumeRef(volumeId);
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );
    const headers = { 'X-Auth-Token': token } as Record<string, string>;
    this.logger.log(
      `[Scaleway] detach SBS volume=${parsed.id} zone=${parsed.zone}`,
    );
    try {
      const lookup = await axios.get(
        `https://api.scaleway.com/block/v1/zones/${parsed.zone}/volumes/${parsed.id}`,
        { headers, timeout: 30000 },
      );
      const refs = (lookup.data?.references ?? []) as Array<{
        id: string;
        product_resource_type: string;
      }>;
      const instanceRef = refs.find(
        (r) => r?.product_resource_type === 'instance_server',
      );
      if (!instanceRef?.id) {
        this.logger.warn(
          `[Scaleway] volume ${parsed.id} has no instance reference — nothing to detach`,
        );
        return {};
      }
      // SBS detach: delete the reference via Block API. Instance API has no
      // detach_volume action — that's a legacy local-storage concept.
      await axios.delete(
        `https://api.scaleway.com/block/v1/zones/${parsed.zone}/volumes/${parsed.id}/references/${instanceRef.id}`,
        { headers, timeout: 30000 },
      );
      return {};
    } catch (err: any) {
      if (err.response?.status === 404) {
        this.logger.warn(
          `[Scaleway] volume ${parsed.id} not found during detach — treating as success`,
        );
        return {};
      }
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      throw new Error(
        `Scaleway detach volume failed for ${parsed.id}: ${detail}`,
      );
    }
  }

  async deleteVolume(volumeId: string): Promise<void> {
    const parsed = this.parseVolumeRef(volumeId);
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );
    const headers = { 'X-Auth-Token': token } as Record<string, string>;
    this.logger.log(
      `[Scaleway] delete SBS volume=${parsed.id} zone=${parsed.zone}`,
    );
    try {
      await axios.delete(
        `https://api.scaleway.com/block/v1/zones/${parsed.zone}/volumes/${parsed.id}`,
        { headers, timeout: 30000 },
      );
    } catch (err: any) {
      if (err.response?.status === 404) {
        this.logger.warn(`[Scaleway] volume ${parsed.id} already gone`);
        return;
      }
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      throw new Error(
        `Scaleway delete volume failed for ${parsed.id}: ${detail}`,
      );
    }
  }

  async listFluiManagedVolumes(): Promise<ProviderVolumeSummary[]> {
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );
    const headers = { 'X-Auth-Token': token } as Record<string, string>;
    const zones = ['fr-par-1', 'fr-par-2', 'nl-ams-1', 'pl-waw-1'];
    const results: ProviderVolumeSummary[] = [];
    for (const zone of zones) {
      try {
        const res = await axios.get(
          `https://api.scaleway.com/block/v1/zones/${zone}/volumes`,
          {
            headers,
            params: { tags: 'managed-by=flui-cloud' },
            timeout: 30000,
          },
        );
        for (const v of res.data?.volumes ?? []) {
          const tags: string[] = v.tags ?? [];
          if (!tags.includes('managed-by=flui-cloud')) continue;
          const labels: Record<string, string> = {};
          for (const t of tags) {
            const eq = t.indexOf('=');
            if (eq > 0) labels[t.slice(0, eq)] = t.slice(eq + 1);
          }
          const serverRef = (v.references ?? []).find(
            (r: any) => r?.product_resource_type === 'instance_server',
          );
          results.push({
            volumeId: `${zone}:${v.id}`,
            name: v.name,
            sizeGb: Math.round((v.size ?? 0) / 1_000_000_000),
            region: zone,
            attachedServerId: serverRef?.product_resource_id ?? null,
            labels,
            createdAt: v.created_at,
          });
        }
      } catch (err: any) {
        if (err.response?.status === 404) continue;
        this.logger.warn(
          `[Scaleway] listFluiManagedVolumes in ${zone} failed: ${err.message}`,
        );
      }
    }
    return results;
  }

  private parseVolumeRef(volumeId: string): { zone: string; id: string } {
    const colon = volumeId.indexOf(':');
    if (colon < 0) {
      throw new Error(
        `Scaleway volume id must be "<zone>:<uuid>" (got "${volumeId}")`,
      );
    }
    return { zone: volumeId.slice(0, colon), id: volumeId.slice(colon + 1) };
  }

  async powerOffServer(serverId: string): Promise<void> {
    const parsed = this.parseResourceId(serverId);
    if (!parsed) throw new Error(`Invalid resource ID: ${serverId}`);

    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );

    if (parsed.family === 'instance') {
      await this.instancesAdapter.serverAction(
        token,
        parsed.zone,
        parsed.id,
        ServerActionRequestActionEnum.Poweroff,
      );
    } else {
      await this.baremetalAdapter.stopServer(token, parsed.zone, parsed.id);
    }
  }

  async updateServerLabels(
    serverId: string,
    labels: Record<string, string>,
  ): Promise<void> {
    const parsed = this.parseResourceId(serverId);
    if (!parsed) throw new Error(`Invalid resource ID: ${serverId}`);

    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );
    const tags = this.labelsToTags(labels);

    if (parsed.family === 'instance') {
      await this.instancesAdapter.updateServerTags(
        token,
        parsed.zone,
        parsed.id,
        tags,
      );
    } else {
      await this.baremetalAdapter.updateServerTags(
        token,
        parsed.zone,
        parsed.id,
        tags,
      );
    }
  }

  async getNodeSizes(
    includeAvailability: boolean = true,
  ): Promise<NodeSizeDto[]> {
    try {
      const token = await this.credentialProvider.getActiveApiToken(
        CloudProvider.SCALEWAY,
      );
      const nodeSizes: NodeSizeDto[] = [];

      // ── Instance types ────────────────────────────────────────────────────
      // Fetch from all zones to build per-region availability + pricing.
      // Types and specs are identical across zones; only availability may differ.
      try {
        // Map: typeName → { typeData, availableRegions: Set<string>, pricesByRegion }
        const typeMap = new Map<
          string,
          {
            type: ReturnType<typeof Object.assign>;
            availableRegions: Set<string>;
            pricesByRegion: Map<
              string,
              { hourly: number; monthlyCap?: number }
            >;
          }
        >();

        const instanceZoneResults = await Promise.allSettled(
          INSTANCE_ZONES.map((zone) =>
            this.instancesAdapter.listServerTypes(token, zone),
          ),
        );

        for (const [i, result] of instanceZoneResults.entries()) {
          if (result.status !== 'fulfilled') continue;
          const zone = INSTANCE_ZONES[i];
          const region = (zone as string).replace(/-\d+$/, '');
          for (const t of result.value) {
            if (!t.name) continue;
            if (!typeMap.has(t.name)) {
              typeMap.set(t.name, {
                type: t,
                availableRegions: new Set(),
                pricesByRegion: new Map(),
              });
            }
            const entry = typeMap.get(t.name);
            entry.availableRegions.add(region);
            if (t.hourly_price != null && !entry.pricesByRegion.has(region)) {
              entry.pricesByRegion.set(region, {
                hourly: t.hourly_price,
                monthlyCap:
                  typeof t.monthly_price === 'number' && t.monthly_price > 0
                    ? t.monthly_price
                    : undefined,
              });
            }
          }
        }

        const mapArch = (arch: string | undefined): 'x86' | 'arm' => {
          if (arch === 'arm' || arch === 'arm64') return 'arm';
          return 'x86';
        };

        const hasLocalSsd = (t: ReturnType<typeof Object.assign>): boolean => {
          // l_ssd can be present as an empty object {} on block-storage-only types (PRO2, ENT1…).
          // Only consider it a real local SSD if max_size > 0.
          return (t.per_volume_constraint?.l_ssd?.max_size ?? 0) > 0;
        };

        const mapVolumeType = (
          t: ReturnType<typeof Object.assign>,
        ): 'local' | 'network' => {
          return hasLocalSsd(t) ? 'local' : 'network';
        };

        const mapDiskGb = (t: ReturnType<typeof Object.assign>): number => {
          // Scaleway uses decimal bytes (1 GB = 1_000_000_000), not binary GiB.
          // volumes_constraint.max_size is the default root disk size for LSSD types
          // (e.g. DEV1-S max=20_000_000_000 → 20 GB, GP1-S max=300_000_000_000 → 300 GB).
          // min_size is always 0 — not useful. Block-storage-only types have max_size=0 → disk=0.
          if (!hasLocalSsd(t)) return 0;
          const volMax = t.volumes_constraint?.max_size ?? 0;
          return volMax > 0 ? Math.round(volMax / 1e9) : 0;
        };

        const mapCpuType = (name: string): 'shared' | 'dedicated' => {
          // DEV, STARDUST, PLAY2 → shared vCPU; GP1, PRO2, ENT1, POP2, COPARM → dedicated vCPU
          const shared = /^(DEV|STARDUST|PLAY2)/i.test(name);
          return shared ? 'shared' : 'dedicated';
        };

        for (const [name, entry] of typeMap.entries()) {
          const t = entry.type;
          const ramBytes = t.ram || 0;
          // RAM is reported in binary bytes (8 GiB = 8_589_934_592), unlike disk
          // which is decimal. Divide by 1024³ so a "8G" plan reads 8 GB, not 9.
          const ramGb = Math.round(ramBytes / 1024 ** 3);
          const diskGb = mapDiskGb(t);

          const prices: NodeSizePriceDto[] = [];
          for (const [region, p] of entry.pricesByRegion.entries()) {
            // Scaleway bills min(hourly * hours, monthly_cap). Prefer the
            // provider-declared monthly cap so estimates match what the
            // customer actually pays. Fall back to hourly * 720 only when the
            // cap is missing or zero (some new types omit it).
            const monthly =
              p.monthlyCap ?? Math.round(p.hourly * 720 * 1000) / 1000;
            prices.push({
              location: region,
              priceHourly: { net: String(p.hourly), gross: String(p.hourly) },
              priceMonthly: { net: String(monthly), gross: String(monthly) },
            });
          }

          const availability = Array.from(entry.availableRegions).map(
            (region) => ({
              location: region,
              available: true,
              deprecated: t.end_of_service ?? false,
            }),
          );

          nodeSizes.push({
            id: name,
            name,
            description: `Scaleway ${name} — ${t.ncpus || 0} vCPU, ${ramGb} GB RAM`,
            cores: t.ncpus || 0,
            memory: ramGb,
            disk: diskGb,
            storageType: mapVolumeType(t),
            cpuType: mapCpuType(name),
            architecture: mapArch(t.arch),
            deprecated: t.end_of_service ?? false,
            bareMetal: false,
            managedFirewall: true, // Security Groups work on all Scaleway Instances
            supportsHourlyBilling: true,
            blockStoragePricePerGbMonthly:
              mapVolumeType(t) === 'network'
                ? SBS_5K_PRICE_PER_GB_MONTHLY
                : undefined,
            prices,
            locations: availability.map((av) => ({
              id: 0,
              name: av.location,
              deprecation: null,
            })),
            availability,
          });
        }
      } catch (err) {
        this.logger.warn(
          'Failed to fetch Scaleway instance types',
          err.message,
        );
      }

      // ── Baremetal offers (per zone, deduplicated by offer_id) ─────────────
      const seenOfferIds = new Set<string>();
      const baremetalResults = await Promise.allSettled(
        BAREMETAL_ZONES.map((zone) =>
          this.baremetalAdapter.listOffers(token, zone),
        ),
      );
      for (const [i, result] of baremetalResults.entries()) {
        if (result.status !== 'fulfilled') continue;
        const zone = BAREMETAL_ZONES[i];
        for (const offer of result.value) {
          if (!offer.id || seenOfferIds.has(offer.id)) continue;
          seenOfferIds.add(offer.id);

          // Sum across all CPU sockets, memory modules, and physical disks
          const totalCores = (offer.cpus || []).reduce(
            (s, c) => s + (c.core_count || 0),
            0,
          );
          const totalMemoryBytes = (offer.memories || []).reduce(
            (s, m) => s + (m.capacity || 0),
            0,
          );
          const totalDiskBytes = (offer.disks || []).reduce(
            (s, d) => s + (d.capacity || 0),
            0,
          );

          const priceHourly = offer.price_per_hour;
          const priceMonthly = offer.price_per_month;

          const formatPrice = (
            p: { units?: number; nanos?: number } | undefined,
          ): string => {
            if (!p) return '0';
            return String((p.units || 0) + (p.nanos || 0) / 1e9);
          };
          const priceEntry: NodeSizePriceDto = {
            location: zone,
            priceHourly: {
              net: formatPrice(priceHourly),
              gross: formatPrice(priceHourly),
            },
            priceMonthly: {
              net: formatPrice(priceMonthly),
              gross: formatPrice(priceMonthly),
            },
          };

          const regionName = (zone as string).replace(/-\d+$/, ''); // fr-par-1 → fr-par
          nodeSizes.push({
            id: offer.id,
            name: offer.name || offer.id,
            description: offer.name || offer.id,
            cores: totalCores,
            memory: Math.round(totalMemoryBytes / 1e9), // decimal bytes → GB
            disk: Math.round(totalDiskBytes / 1e9), // sum of all physical disks → GB
            storageType: 'local',
            cpuType: 'dedicated',
            architecture: 'x86',
            deprecated: !(offer.enable ?? true),
            bareMetal: true,
            managedFirewall: false, // Scaleway Security Groups are not available on Elastic Metal
            supportsHourlyBilling: true, // Elastic Metal supports hourly billing (pay-as-you-go)
            prices: [priceEntry],
            locations: [{ id: 0, name: regionName, deprecation: null }],
            availability: [
              {
                location: regionName,
                available: offer.enable ?? true,
                deprecated: false,
              },
            ],
          });
        }
      }

      return nodeSizes;
    } catch (error) {
      this.logger.error('Failed to fetch Scaleway node sizes', error.message);
      return [];
    }
  }

  // ─── VNet / Private Network Management ────────────────────────────────────

  async createVNet(config: CreateVNetConfig): Promise<VNetCreationResult> {
    const region = this.extractRegionFromLabels(config.labels) ?? 'fr-par';
    const tags = (config.labels ?? []).map((l) => `${l.key}=${l.value}`);
    const subnets =
      config.subnets?.map((s) => s.ipRange) ??
      (config.ipRange ? [config.ipRange] : []);
    return this.vpcAdapter.createPrivateNetwork(
      region,
      config.name,
      tags,
      subnets,
    );
  }

  async deleteVNet(vnetId: string): Promise<VNetDeletionResult> {
    const { region, id } = this.vpcAdapter.parseVnetId(vnetId);
    await this.vpcAdapter.deletePrivateNetwork(region, id);
    return { message: `Private Network ${id} deleted` };
  }

  async getVNet(vnetId: string): Promise<VNetDetails | null> {
    const { region, id } = this.vpcAdapter.parseVnetId(vnetId);
    return this.vpcAdapter.getPrivateNetwork(region, id);
  }

  async listVNets(): Promise<VNetDetails[]> {
    const regions = ['fr-par', 'nl-ams', 'pl-waw'];
    const results = await Promise.all(
      regions.map((r) => this.vpcAdapter.listPrivateNetworks(r)),
    );
    return results.flat();
  }

  async addSubnet(config: AddSubnetConfig): Promise<{ actionId?: number }> {
    const { region, id } = this.vpcAdapter.parseVnetId(config.vnetId);
    await this.vpcAdapter.addSubnets(region, id, [config.ipRange]);
    return {};
  }

  async deleteSubnet(
    config: DeleteSubnetConfig,
  ): Promise<{ actionId?: number }> {
    const { region, id } = this.vpcAdapter.parseVnetId(config.vnetId);
    await this.vpcAdapter.deleteSubnets(region, id, [config.ipRange]);
    return {};
  }

  async addRoute(config: AddRouteConfig): Promise<{ actionId?: number }> {
    // Scaleway routes are managed at VPC level, not Private Network level
    this.logger.warn(
      `addRoute is not supported for Scaleway Private Networks (destination=${config.destination})`,
    );
    return {};
  }

  async deleteRoute(config: DeleteRouteConfig): Promise<{ actionId?: number }> {
    this.logger.warn(
      `deleteRoute is not supported for Scaleway Private Networks (destination=${config.destination})`,
    );
    return {};
  }

  async attachServerToVNet(
    config: AttachServerToVNetConfig,
  ): Promise<ServerVNetAttachmentResult> {
    const { id: pnId } = this.vpcAdapter.parseVnetId(config.vnetId);
    const parsed = this.parseResourceId(config.serverId);

    if (parsed?.family === 'baremetal') {
      await this.vpcAdapter.attachBaremetalToPrivateNetwork(
        parsed.zone,
        parsed.id,
        pnId,
      );
      return {
        message: `Elastic Metal server ${parsed.id} attached to private network ${pnId}`,
      };
    }

    // For Instances: attachment is handled automatically by Scaleway IPAM/DHCP
    // when the private network is assigned at server creation time
    this.logger.log(
      `Instance ${config.serverId} — private network attachment managed by Scaleway IPAM (no explicit API call needed)`,
    );
    return {
      message: `Instance ${config.serverId} uses Scaleway IPAM for private network connectivity`,
    };
  }

  async detachServerFromVNet(
    config: DetachServerFromVNetConfig,
  ): Promise<{ actionId?: number }> {
    const { id: pnId } = this.vpcAdapter.parseVnetId(config.vnetId);
    const parsed = this.parseResourceId(config.serverId);

    if (parsed?.family === 'baremetal') {
      await this.vpcAdapter.detachBaremetalFromPrivateNetwork(
        parsed.zone,
        parsed.id,
        pnId,
      );
    } else {
      this.logger.log(
        `Instance ${config.serverId} — private network detachment managed by Scaleway IPAM`,
      );
    }
    return {};
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private extractRegionFromLabels(
    labels?: { key: string; value: string }[],
  ): string | null {
    const label = labels?.find(
      (l) => l.key === 'region' || l.key === 'scaleway-region',
    );
    return label?.value ?? null;
  }

  // ─── SSH Key Registry (IAM) ──────────────────────────────────────────────────

  async resolveSSHKeys(keys: SshKeyInfo[]): Promise<string[]> {
    const providerIds: string[] = [];

    for (const key of keys) {
      if (key.existingProviderId) {
        this.logger.log(
          `[Scaleway] SSH key "${key.name}" already synced → provider ID: ${key.existingProviderId}`,
        );
        providerIds.push(key.existingProviderId);
        continue;
      }

      try {
        const result = await this.createSSHKey(key.name, key.publicKey);
        this.logger.log(
          `[Scaleway] SSH key "${key.name}" created on IAM → provider ID: ${result.id}`,
        );
        providerIds.push(result.id);
      } catch (error) {
        if (error.message?.includes('already exists')) {
          const existing = await this.listSSHKeys();
          const match = existing.find(
            (k) => k.fingerprint === key.fingerprint || k.name === key.name,
          );
          if (match) {
            this.logger.log(
              `[Scaleway] SSH key "${key.name}" already exists on IAM → provider ID: ${match.id}`,
            );
            providerIds.push(match.id);
            continue;
          }
        }
        this.logger.error(
          `[Scaleway] Failed to resolve SSH key "${key.name}": ${error.message}`,
        );
        throw error;
      }
    }

    this.logger.log(
      `[Scaleway] resolveSSHKeys complete — ${providerIds.length} key(s) resolved: [${providerIds.join(', ')}]`,
    );
    return providerIds;
  }

  async listSSHKeys(): Promise<SSHKeyDto[]> {
    const keys = await this.iamAdapter.listSSHKeys();
    return keys.map((k) => ({
      id: k.id ?? '',
      name: k.name ?? '',
      publicKey: k.public_key ?? '',
      fingerprint: k.fingerprint ?? '',
      type: this.extractKeyType(k.public_key),
      createdAt: k.created_at ? new Date(k.created_at) : new Date(),
      updatedAt: k.updated_at ? new Date(k.updated_at) : undefined,
      source: CloudProvider.SCALEWAY,
      syncedFromProvider: true,
      providerKeyId: k.id,
      isActive: !(k.disabled ?? false),
      autoGenerated: false,
    }));
  }

  async createSSHKey(
    name: string,
    publicKey: string,
    labels?: Record<string, string>, // Scaleway IAM SSH keys don't support tags — accepted for interface compliance
  ): Promise<SSHKeyCreationResult> {
    try {
      return await this.iamAdapter.createSSHKey(name, publicKey, labels);
    } catch (e) {
      if (e.response?.status === 409) {
        throw new Error(
          `SSH key with name "${name}" already exists on Scaleway`,
        );
      }
      throw e;
    }
  }

  async deleteSSHKey(providerKeyId: string): Promise<void> {
    try {
      await this.iamAdapter.deleteSSHKey(providerKeyId);
    } catch (e) {
      if (e.response?.status === 404) return;
      throw e;
    }
  }

  async getSSHKey(providerKeyId: string): Promise<SSHKeyDetails> {
    const k = await this.iamAdapter.getSSHKey(providerKeyId);
    return {
      id: k.id ?? '',
      name: k.name ?? '',
      publicKey: k.public_key ?? '',
      fingerprint: k.fingerprint ?? '',
    };
  }

  private extractKeyType(publicKey?: string): string {
    if (publicKey?.startsWith('ssh-rsa')) return 'rsa';
    if (publicKey?.startsWith('ssh-ed25519')) return 'ed25519';
    if (publicKey?.startsWith('ecdsa-sha2')) return 'ecdsa';
    return 'unknown';
  }
}
