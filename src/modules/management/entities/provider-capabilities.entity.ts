import { ProviderRegion } from './provider-region.entity';
import { InferenceCapability } from '../../providers/interfaces/inference-capability';

/**
 * Describes how VNets are scoped for a provider:
 * - 'global': a single VNet spans all locations within a zone, but cross-zone VNets are
 *   NOT possible (e.g. Hetzner: eu-central covers fsn1/nbg1/hel1 in one VNet, but
 *   eu-central and us-east cannot share a VNet — you need one per zone)
 * - 'regional': a VNet is strictly one-region (e.g. Scaleway: fr-par, nl-ams, pl-waw
 *   each require a separate VNet)
 *
 * In practice both models require one VNet per zone/region — the difference is whether
 * multiple datacenters share a zone (Hetzner eu-central) or each datacenter is its
 * own zone (Scaleway).
 */
export type VNetScope = 'global' | 'regional' | 'manual';

/**
 * A logical network zone that can be targeted when creating a VNet.
 * For Hetzner each zone (eu-central, us-east, …) covers multiple locations.
 * For Scaleway each zone maps 1:1 to a region (fr-par, nl-ams, pl-waw).
 */
export interface VNetZone {
  /** Internal zone/region identifier used in API calls */
  id: string;
  /** Human-readable label */
  displayName: string;
  /** Provider regions physically covered by this zone */
  coveredRegions: string[];
}

/**
 * CIDR prefix constraints for VNet and subnet IP ranges.
 * minPrefix is the largest block allowed (smallest number, e.g. /8).
 * maxPrefix is the smallest block allowed (largest number, e.g. /29).
 * Example Scaleway: vnet { min:20, max:28 }, subnet { min:20, max:28 }
 * Example Hetzner:  vnet { min:8, max:29 }, subnet { min:8, max:29 }
 */
export interface IpRangeConstraints {
  /** Minimum prefix length (largest block), e.g. 8 means /8 is allowed */
  minPrefix: number;
  /** Maximum prefix length (smallest block), e.g. 29 means /29 is the smallest allowed */
  maxPrefix: number;
}

export interface VNetTopology {
  scope: VNetScope;
  /** All addressable zones when creating a VNet */
  zones: VNetZone[];
  /**
   * Whether the provider supports explicit subnets inside a VNet.
   * True for Hetzner (subnets are a distinct resource nested inside the network).
   * False for Scaleway (the Private Network is itself the flat subnet — no nesting).
   */
  supportsSubnets: boolean;
  /**
   * Whether subnets inside a VNet can be assigned to individual zones.
   * True for Hetzner (one subnet per network_zone), false for Scaleway
   * (subnets are flat within the region).
   */
  subnetPerZone: boolean;
  /** Whether the provider supports explicit routing tables on VNets */
  supportsRoutes: boolean;
  /**
   * Whether all VNets share one address space (a VPC), so ranges across
   * different VNets must not overlap. True for Scaleway (VPC per region);
   * false/omitted for Hetzner, whose networks are isolated and may reuse ranges.
   */
  sharedAddressSpace?: boolean;
  /** Allowed CIDR prefix range for the VNet IP range */
  vnetIpRange: IpRangeConstraints;
  /** Allowed CIDR prefix range for individual subnets */
  subnetIpRange: IpRangeConstraints;
}

export interface ProviderCapabilities {
  supportedInstanceTypes: string[];
  supportedRegions: ProviderRegion[];
  credentialType:
    | 'api_key'
    | 'access_key_secret'
    | 'bearer_token'
    | 'user_password'
    | 'ssh';
  features: {
    autoScaling: boolean;
    loadBalancers: boolean;
    privateNetworking: boolean;
    snapshots: boolean;
    backups: boolean;
    dnsZones: boolean;
    /** Whether Flui can programmatically add/remove nodes via this provider's API */
    nodeProvisioning: boolean;
  };
  pricing: {
    currency: string;
    billingCycle: 'hourly' | 'monthly';
    minimumCost: number;
  };
  firewall: {
    backend: 'managed-api' | 'host-nftables' | 'none';
    managedEdge: boolean;
    supportsSshAllowlist: boolean;
  };
  /** VNet topology info — null when privateNetworking is false */
  vnetTopology: VNetTopology | null;
  vnetRequired: boolean;
  crossClusterAllowed: boolean;
  /** Present only for inference-capable providers (e.g. Scaleway Generative APIs). */
  inference?: InferenceCapability;
}
