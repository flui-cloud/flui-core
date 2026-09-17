// Generic DTO for node sizes - no dependencies on other modules
export class PriceDetailDto {
  net: string;
  gross: string;
}

export class NodeSizePriceDto {
  location: string;
  priceHourly: PriceDetailDto;
  priceMonthly: PriceDetailDto;
}

export class DeprecationInfoDto {
  unavailable_after: string;
  announced: string;
}

export class NodeSizeLocationDto {
  id: number;
  name: string;
  deprecation: DeprecationInfoDto | null;
}

export class NodeSizeLocationAvailabilityDto {
  location: string;
  available: boolean;
  deprecated: boolean;
  /**
   * Whether `available` was actually asked of the provider.
   *
   * "We do not track this" and "there is none" are opposite answers, and a
   * screen that renders the first as the second tells the reader something
   * false. Hetzner publishes per-datacentre stock and sets this true; OVH
   * publishes nothing an OpenStack credential can read, so it says so rather
   * than promising. Optional, and absent means known: a consumer that ignores
   * it behaves exactly as before.
   */
  availabilityKnown?: boolean;
}

export class NodeSizeDto {
  id: string;
  name: string;
  description: string;
  cores: number;
  memory: number; // GB
  disk: number; // GB
  storageType: 'local' | 'network';
  cpuType: 'shared' | 'dedicated';
  architecture: 'x86' | 'arm';
  deprecated: boolean;
  /** Physical dedicated server (e.g. Scaleway Elastic Metal). Distinct from cpuType='dedicated' which is a dedicated vCPU on a shared host. */
  bareMetal: boolean;
  /** Provider supports server-level firewall (Security Groups) for this type. False for bare metal servers on most providers. */
  managedFirewall: boolean;
  /** Pay-as-you-go hourly billing available. False = monthly commitment only → not suitable for autoscale. */
  supportsHourlyBilling: boolean;
  /** Monthly price per GB for block/network storage. Only set when storageType='network'. Absent for local SSD types. */
  blockStoragePricePerGbMonthly?: string;
  prices: NodeSizePriceDto[];
  locations: NodeSizeLocationDto[];
  availability?: NodeSizeLocationAvailabilityDto[];
}
