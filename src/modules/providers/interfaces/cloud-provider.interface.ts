import { InstanceEntity } from '../../instances/entities/instance.entity';
import { ServerResponseDto } from '../../infrastructure/servers/dto/server-response.dto';
import { DeleteServerDto } from '../../infrastructure/servers/dto/delete-server.dto';
import { SSHKeyDto } from '../../access/dto/ssh-key.dto';
import { NodeSizeDto } from '../dto/node-size.dto';
import { PricingDto, PricingQueryDto } from '../dto/pricing.dto';
import {
  CreateVNetConfig,
  VNetCreationResult,
  VNetDetails,
  VNetDeletionResult,
  AddSubnetConfig,
  DeleteSubnetConfig,
  AddRouteConfig,
  DeleteRouteConfig,
  AttachServerToVNetConfig,
  DetachServerFromVNetConfig,
  ServerVNetAttachmentResult,
  ChangeIpRangeConfig,
} from './network-provider.interface';

export interface Label {
  key: string;
  value: string;
}

export interface CreateServerConfig {
  name: string;
  server_type?: string;
  image?: string;
  location?: string;
  ssh_keys?: string[];
  environment?: string;
  cluster_name?: string;
  user_data?: string;
  labels?: Label[];
  firewalls?: string[]; // Array of firewall IDs to attach during server creation
  /** Disk size in GB. Used by providers that require explicit volume sizing (e.g. Scaleway SBS network volumes). Ignored by providers with local storage included in the server type. */
  diskSizeGb?: number;
  /** Provider VNet/network IDs to attach the server to at creation. */
  networks?: string[];
  /**
   * Flui-managed block storage Volumes to create and attach to the server at
   * creation time. Used by §14 of the scaling architecture: master nodes get
   * one Volume that hosts the NFS export for shared cluster storage.
   *
   * The provider implementation creates the Volume(s), waits for them to be
   * ready, attaches them to the new server, and returns the Linux device
   * path(s) so the bootstrap script can format/mount.
   */
  attachedVolumes?: AttachedVolumeRequest[];
}

export interface AttachedVolumeRequest {
  /** Size in GB. */
  sizeGb: number;
  /** Human-friendly label (used for naming the Volume in the provider's panel). */
  name: string;
  /**
   * Optional location/zone hint. If omitted, provider uses the same location
   * as the server.
   */
  location?: string;
  /** Provider labels propagated to the Volume. */
  labels?: Label[];
}

export interface AttachedVolumeResult {
  /** Provider Volume id. */
  volumeId: string;
  /** Linux device path (e.g. /dev/disk/by-id/scsi-0HC_Volume_12345). */
  devicePath: string;
  sizeGb: number;
}

export interface ServerCreationResult {
  /** Volumes created and attached. Empty if attachedVolumes was not requested. */
  attachedVolumes?: AttachedVolumeResult[];
  serverId: string;
  ipAddress?: string;
  privateIp?: string;
  status: string;
  actionId?: number;
}

export interface ServerDeletionResult {
  actionId?: number;
  message: string;
}

export interface SSHKeyCreationResult {
  id: string;
  fingerprint?: string;
}

export interface SSHKeyDetails {
  id: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  labels?: Record<string, string>;
}

/**
 * Flui SSH key data passed to the provider for resolution.
 * The provider uses this to create or retrieve the key on the cloud platform
 * and return the provider-specific key ID.
 */
export interface SshKeyInfo {
  /** Local Flui UUID */
  fluiId: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  /** Cached provider key ID, if already synced */
  existingProviderId?: string;
}

export interface ChangeServerTypeConfig {
  /** Target provider server type name (e.g. `cx32` on Hetzner, `PRO2-S` on Scaleway). */
  targetServerType: string;
  /**
   * Hetzner-only: if true, also grow the local OS disk to the target type's
   * size. This is one-way — once enabled, the server can never be resized
   * back down to a smaller type. Default false to preserve future flexibility.
   * Ignored by providers without local-disk semantics.
   */
  upgradeDisk?: boolean;
}

export interface ProviderVolumeSummary {
  volumeId: string;
  name: string;
  sizeGb: number;
  region?: string;
  attachedServerId?: string | null;
  labels: Record<string, string>;
  createdAt?: string;
}

export interface ProviderSnapshot {
  id: string;
  name: string;
  serverId?: string;
  sizeBytes?: number;
  status: string;
  createdAt?: string;
  description?: string;
}

export interface ICloudProvider {
  listInstances(filters?: any): Promise<InstanceEntity[]>;

  listServersAsDto(): Promise<ServerResponseDto[]>;
  getServerDetailsAsDto(serverId: string): Promise<ServerResponseDto | null>;
  createServer(config: CreateServerConfig): Promise<ServerCreationResult>;
  deleteServer(config: DeleteServerDto): Promise<ServerDeletionResult>;
  getServerStatus(serverId: string): Promise<string>;
  testConnection(): Promise<{ success: boolean; error?: string }>;

  // Server power management
  powerOnServer?(serverId: string): Promise<void>;
  powerOffServer?(serverId: string): Promise<void>;

  /**
   * The instance's serial/virtual console, reachable through the provider's
   * own API rather than the network — the one diagnostic that still answers
   * when SSH/ICMP to the guest do not. Only OVH implements this today; other
   * providers' APIs expose no equivalent as of writing.
   */
  getConsoleOutput?(serverId: string, length?: number): Promise<string>;

  // Server label management
  updateServerLabels?(
    serverId: string,
    labels: Record<string, string>,
  ): Promise<void>;

  // SSH Key Management
  listSSHKeys?(): Promise<SSHKeyDto[]>;
  createSSHKey?(
    name: string,
    publicKey: string,
    labels?: Record<string, string>,
  ): Promise<SSHKeyCreationResult>;
  deleteSSHKey?(providerKeyId: string): Promise<void>;
  getSSHKey?(providerKeyId: string): Promise<SSHKeyDetails>;

  /**
   * Resolve Flui SSH keys to provider-specific key IDs.
   * Creates keys on the provider if not yet present.
   * Returns provider key IDs in the same order as the input array.
   */
  resolveSSHKeys?(keys: SshKeyInfo[]): Promise<string[]>;

  // Pricing and node sizes
  getNodeSizes?(includeAvailability?: boolean): Promise<NodeSizeDto[]>;
  getPricing?(query: PricingQueryDto): Promise<PricingDto>;

  // Network/VNet Management (optional, delegates to INetworkProvider)
  createVNet?(config: CreateVNetConfig): Promise<VNetCreationResult>;
  deleteVNet?(vnetId: string): Promise<VNetDeletionResult>;
  getVNet?(vnetId: string): Promise<VNetDetails | null>;
  listVNets?(): Promise<VNetDetails[]>;
  addSubnet?(config: AddSubnetConfig): Promise<{ actionId?: number }>;
  deleteSubnet?(config: DeleteSubnetConfig): Promise<{ actionId?: number }>;
  addRoute?(config: AddRouteConfig): Promise<{ actionId?: number }>;
  deleteRoute?(config: DeleteRouteConfig): Promise<{ actionId?: number }>;
  changeIpRange?(config: ChangeIpRangeConfig): Promise<{ actionId?: number }>;
  attachServerToVNet?(
    config: AttachServerToVNetConfig,
  ): Promise<ServerVNetAttachmentResult>;
  detachServerFromVNet?(
    config: DetachServerFromVNetConfig,
  ): Promise<{ actionId?: number }>;

  /**
   * Vertical scaling primitives.
   *
   * Maintenance-window semantics: the caller is responsible for stopping the
   * server before invoking `changeServerType` (Hetzner requires the server to
   * be off, Scaleway requires `stopped` state, etc.) and for waiting for the
   * k3s node to rejoin Ready after `powerOnServer`. These primitives only
   * perform the provider-side action and do not orchestrate the cluster.
   *
   * Volume `expandVolume` is online-safe on the provider side, but the
   * caller still needs to run `resize2fs` (or equivalent) over SSH on the
   * server that mounts the volume before the new size becomes usable.
   */
  changeServerType?(
    serverId: string,
    config: ChangeServerTypeConfig,
  ): Promise<{ actionId?: number }>;
  expandVolume?(
    volumeId: string,
    newSizeGb: number,
  ): Promise<{ actionId?: number }>;

  /**
   * Volume lifecycle primitives — used on cluster destroy to clean up the
   * Flui-managed shared storage Volume created at master-create time. The
   * caller must `detachVolume` before `deleteVolume` (most providers reject
   * delete-while-attached).
   */
  detachVolume?(volumeId: string): Promise<{ actionId?: number }>;
  deleteVolume?(volumeId: string): Promise<void>;

  /**
   * List all Flui-managed Volumes at the provider, optionally filtered by a
   * label selector. Used by the orphan-volume scan to find Volumes that
   * belong to deleted clusters. The provider must include each Volume's
   * label set so the caller can decide ownership.
   */
  listFluiManagedVolumes?(): Promise<ProviderVolumeSummary[]>;

  // OS-level snapshots (L3 backup) — optional, providers signal support via supportsServerSnapshots
  supportsServerSnapshots?(): boolean;
  createServerSnapshot?(
    serverId: string,
    name: string,
    description?: string,
  ): Promise<ProviderSnapshot>;
  listServerSnapshots?(serverId: string): Promise<ProviderSnapshot[]>;
  deleteServerSnapshot?(snapshotId: string): Promise<void>;
  restoreServerFromSnapshot?(
    serverId: string,
    snapshotId: string,
  ): Promise<void>;
}
