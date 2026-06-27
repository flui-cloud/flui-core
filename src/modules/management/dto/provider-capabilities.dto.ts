import { ApiProperty } from '@nestjs/swagger';
import { VNetScope } from '../entities/provider-capabilities.entity';

export class IpRangeConstraintsDto {
  @ApiProperty({
    description:
      'Minimum CIDR prefix (largest block allowed), e.g. 8 means /8 is valid',
    example: 8,
  })
  minPrefix: number;

  @ApiProperty({
    description:
      'Maximum CIDR prefix (smallest block allowed), e.g. 29 means /29 is the smallest valid',
    example: 29,
  })
  maxPrefix: number;
}

export class VNetZoneDto {
  @ApiProperty({
    description: 'Internal zone/region identifier used in API calls',
    example: 'eu-central',
  })
  id: string;

  @ApiProperty({ example: 'Europe (Central)' })
  displayName: string;

  @ApiProperty({
    type: [String],
    description: 'Provider region IDs physically covered by this zone',
    example: ['fsn1', 'nbg1', 'hel1'],
  })
  coveredRegions: string[];
}

export class VNetTopologyDto {
  @ApiProperty({
    enum: ['global', 'regional'],
    description:
      'global = one VNet spans all regions; regional = one VNet per region',
    example: 'global',
  })
  scope: VNetScope;

  @ApiProperty({
    type: [VNetZoneDto],
    description: 'Addressable zones when creating a VNet',
  })
  zones: VNetZoneDto[];

  @ApiProperty({
    description:
      'Whether the provider supports explicit subnets inside a VNet (Hetzner yes, Scaleway no — the Private Network is itself the flat subnet)',
    example: true,
  })
  supportsSubnets: boolean;

  @ApiProperty({
    description:
      'Whether subnets inside a VNet can target individual zones (Hetzner yes, Scaleway no)',
    example: true,
  })
  subnetPerZone: boolean;

  @ApiProperty({
    description:
      'Whether the provider supports explicit routing tables on VNets',
    example: true,
  })
  supportsRoutes: boolean;

  @ApiProperty({
    type: IpRangeConstraintsDto,
    description: 'Allowed CIDR prefix range for the VNet IP range',
  })
  vnetIpRange: IpRangeConstraintsDto;

  @ApiProperty({
    type: IpRangeConstraintsDto,
    description: 'Allowed CIDR prefix range for individual subnets',
  })
  subnetIpRange: IpRangeConstraintsDto;
}

export class ProviderRegionDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  displayName: string;

  @ApiProperty()
  country: string;

  @ApiProperty()
  available: boolean;
  @ApiProperty({ required: false })
  flagEmoji?: string;
  @ApiProperty()
  location: string;
  @ApiProperty({ required: false })
  description?: string;
  @ApiProperty({ required: false })
  latitude?: number;
  @ApiProperty({ required: false })
  longitude?: number;
}

export class ProviderFeaturesDto {
  @ApiProperty()
  autoScaling: boolean;

  @ApiProperty()
  loadBalancers: boolean;

  @ApiProperty()
  privateNetworking: boolean;

  @ApiProperty()
  snapshots: boolean;

  @ApiProperty()
  backups: boolean;

  @ApiProperty()
  dnsZones: boolean;

  @ApiProperty({
    description:
      'Whether Flui can add/remove nodes via this provider API (false for BYOS)',
  })
  nodeProvisioning: boolean;
}

export class ProviderFirewallDto {
  @ApiProperty({
    enum: ['managed-api', 'host-nftables', 'none'],
    description:
      'How the node firewall is enforced: provider API (cloud edge), host nftables over SSH, or none',
    example: 'managed-api',
  })
  backend: 'managed-api' | 'host-nftables' | 'none';

  @ApiProperty({
    description:
      'True when filtering happens at the cloud edge (managed API) vs on the host',
    example: true,
  })
  managedEdge: boolean;

  @ApiProperty({
    description:
      'Whether port 22 may be IP-allowlisted. Only when an out-of-band recovery channel exists (managedEdge); host-firewall hosts keep 22 open + CA-only to avoid lockout',
    example: true,
  })
  supportsSshAllowlist: boolean;
}

export class ProviderPricingDto {
  @ApiProperty()
  currency: string;

  @ApiProperty({ enum: ['hourly', 'monthly'] })
  billingCycle: 'hourly' | 'monthly';

  @ApiProperty()
  minimumCost: number;
}

export class ProviderCapabilitiesDto {
  @ApiProperty({ type: [String] })
  supportedInstanceTypes: string[];

  @ApiProperty({ type: [ProviderRegionDto] })
  supportedRegions: ProviderRegionDto[];

  @ApiProperty({
    enum: [
      'api_key',
      'access_key_secret',
      'bearer_token',
      'user_password',
      'ssh',
    ],
  })
  credentialType:
    | 'api_key'
    | 'access_key_secret'
    | 'bearer_token'
    | 'user_password'
    | 'ssh';

  @ApiProperty({ type: ProviderFeaturesDto })
  features: ProviderFeaturesDto;

  @ApiProperty({ type: ProviderFirewallDto })
  firewall: ProviderFirewallDto;

  @ApiProperty({ type: ProviderPricingDto })
  pricing: ProviderPricingDto;

  @ApiProperty({
    required: false,
    nullable: true,
    type: VNetTopologyDto,
    description: 'VNet topology info — null when privateNetworking is false',
  })
  vnetTopology: VNetTopologyDto | null;

  @ApiProperty({
    description:
      'Whether a VNet/Subnet must be selected when creating a cluster on this provider',
    example: true,
  })
  vnetRequired: boolean;

  @ApiProperty({
    description:
      'Whether a workload may target a provider different from the control cluster provider',
    example: false,
  })
  crossClusterAllowed: boolean;
}
