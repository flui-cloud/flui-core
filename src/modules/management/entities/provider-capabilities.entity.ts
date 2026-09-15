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
/**
 * Who provides the private network.
 *
 * `manual` means the operator wired one and Flui merely records it;
 * `flui-managed` means there is none to record and Flui builds it — the case
 * where a BYOS estate's nodes have only public addresses, and their pod traffic
 * would otherwise cross the internet in clear.
 */
export type VNetScope = 'global' | 'regional' | 'manual' | 'flui-managed';

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
  /**
   * Whether Flui can build the private network itself here, as an alternative
   * to whatever this provider offers.
   *
   * Separate from `vnetTopology.scope`, which says who provides the network by
   * default. The two coexist on the same provider: one BYOS operator has a
   * wired LAN, the next has four machines in four datacentres, and a single
   * value would have to lie to one of them. So the default stays in `scope`,
   * the choice is made per cluster, and this flag only says the choice exists —
   * which is what lets an interface offer it instead of requiring the API.
   */
  supportsFluiManagedVNet?: boolean;
  /** Present only for inference-capable providers (e.g. Scaleway Generative APIs). */
  inference?: InferenceCapability;
  /**
   * Whether a second getNodeSizes(includeAvailability=true) call returns a
   * genuinely fresher signal than the cached metadata call — true for
   * providers with real per-datacenter stock (Hetzner, Scaleway). False when
   * availability is just a static projection of the same catalog snapshot
   * (OVH's public pricing catalog has no live stock concept), in which case
   * management.service.ts skips the redundant second fetch entirely.
   */
  hasLiveAvailability: boolean;
}
