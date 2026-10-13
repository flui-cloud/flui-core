import { Label } from './cloud-provider.interface';

export interface VNetSubnetConfig {
  ipRange: string; // CIDR notation, e.g., "10.0.1.0/24"
  networkZone: string; // e.g., "eu-central", "us-east"
  gateway?: string; // Gateway IP (optional, auto-assigned if not provided)
  vswitchId?: string; // Robot vSwitch ID (for vswitch connections — Hetzner-internal)
}

export interface VNetRouteConfig {
  destination: string; // Destination network in CIDR notation
  gateway: string; // Gateway IP for routing
}

export interface CreateVNetConfig {
  name: string;
  ipRange: string; // CIDR notation, must be RFC1918 private range, min /24
  /** One of the zones the provider declares in its VNet topology. */
  networkZone?: string;
  labels?: Label[];
  subnets?: VNetSubnetConfig[]; // Initial subnets to create
  routes?: VNetRouteConfig[]; // Initial routes to add
  exposeRoutesToVSwitch?: boolean; // Expose routes to vSwitch connection
}

export interface VNetCreationResult {
  vnetId: string; // Provider's network ID
  ipRange: string;
  subnets?: VNetSubnetInfo[];
}

export interface VNetSubnetInfo {
  id?: string; // Provider's subnet ID (if applicable)
  ipRange: string;
  networkZone: string;
  gateway?: string;
}

export interface VNetRouteInfo {
  destination: string;
  gateway: string;
}

export interface VNetDetails {
  id: string; // Provider's network ID
  name: string;
  ipRange: string;
  subnets: VNetSubnetInfo[];
  routes: VNetRouteInfo[];
  attachedServerIds: string[]; // Server IDs attached to this network
  attachedLoadBalancerIds?: string[]; // Load balancer IDs (if supported)
  labels?: Record<string, string>;
  created?: string; // ISO timestamp
}

export interface VNetDeletionResult {
  message: string;
  actionId?: number;
}

export interface AddSubnetConfig {
  vnetId: string;
  ipRange?: string; // Optional, auto-assigned if not provided
  networkZone: string;
  vswitchId?: string; // For vswitch connections — Hetzner-internal
}

export interface AddSubnetResult {
  actionId?: number;
  subnetId?: string;
  ipRange: string;
  networkZone?: string;
  gateway?: string;
}

export interface DeleteSubnetConfig {
  vnetId: string;
  ipRange: string; // CIDR of subnet to delete
}

export interface AddRouteConfig {
  vnetId: string;
  destination: string; // Destination CIDR
  gateway: string; // Gateway IP
}

export interface DeleteRouteConfig {
  vnetId: string;
  destination: string; // Destination CIDR
  gateway: string; // Gateway IP (required by Hetzner to identify the route)
}

export interface AttachServerToVNetConfig {
  serverId: string;
  vnetId: string;
  ip?: string; // Specific IP to assign (optional, auto-assigned if not provided)
  aliasIps?: string[]; // Additional IPs for the server
}

export interface DetachServerFromVNetConfig {
  serverId: string;
  vnetId: string;
}

export interface ServerVNetAttachmentResult {
  actionId?: number;
  assignedIp?: string;
  message: string;
}

export interface ChangeIpRangeConfig {
  vnetId: string;
  newIpRange: string; // New CIDR (can only extend, not shrink)
}

/**
 * Interface for network/VNet operations on cloud providers
 * Implements virtual network management capabilities
 */
export interface INetworkProvider {
  // VNet CRUD Operations
  createVNet(config: CreateVNetConfig): Promise<VNetCreationResult>;
  deleteVNet(vnetId: string): Promise<VNetDeletionResult>;
  getVNet(vnetId: string): Promise<VNetDetails | null>;
  listVNets(): Promise<VNetDetails[]>;

  // Subnet Management
  addSubnet(config: AddSubnetConfig): Promise<AddSubnetResult>;
  deleteSubnet(config: DeleteSubnetConfig): Promise<{ actionId?: number }>;

  // Route Management
  addRoute(config: AddRouteConfig): Promise<{ actionId?: number }>;
  deleteRoute(config: DeleteRouteConfig): Promise<{ actionId?: number }>;

  // IP Range Management
  changeIpRange?(config: ChangeIpRangeConfig): Promise<{ actionId?: number }>;

  // Server Attachment
  attachServerToVNet(
    config: AttachServerToVNetConfig,
  ): Promise<ServerVNetAttachmentResult>;
  detachServerFromVNet(
    config: DetachServerFromVNetConfig,
  ): Promise<{ actionId?: number }>;

  // Protection (optional)
  enableVNetProtection?(vnetId: string): Promise<void>;
  disableVNetProtection?(vnetId: string): Promise<void>;
}
