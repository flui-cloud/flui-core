import { ApiProperty } from '@nestjs/swagger';
import {
  NodeSizeDto,
  NodeSizePriceDto as ProviderNodeSizePriceDto,
  PriceDetailDto as ProviderPriceDetailDto,
  NodeSizeLocationDto as ProviderNodeSizeLocationDto,
  DeprecationInfoDto as ProviderDeprecationInfoDto,
  NodeSizeLocationAvailabilityDto as ProviderNodeSizeLocationAvailabilityDto,
} from 'src/modules/providers/dto/node-size.dto';

// Re-export with Swagger decorators for API documentation
export class PriceDetailDto implements ProviderPriceDetailDto {
  @ApiProperty({ description: 'Price without VAT', example: '5.00' })
  net: string;

  @ApiProperty({ description: 'Price with VAT', example: '5.95' })
  gross: string;
}

export class NodeSizePriceDto implements ProviderNodeSizePriceDto {
  @ApiProperty({ description: 'Location identifier', example: 'nbg1' })
  location: string;

  @ApiProperty({ type: PriceDetailDto })
  priceHourly: PriceDetailDto;

  @ApiProperty({ type: PriceDetailDto })
  priceMonthly: PriceDetailDto;
}

export class DeprecationInfoDto implements ProviderDeprecationInfoDto {
  @ApiProperty({
    description:
      'Date when the server type becomes unavailable in this location',
    example: '2023-09-01T00:00:00Z',
  })
  unavailable_after: string;

  @ApiProperty({
    description: 'Date when deprecation was announced',
    example: '2023-06-01T00:00:00Z',
  })
  announced: string;
}

export class NodeSizeLocationAvailabilityDto
  implements ProviderNodeSizeLocationAvailabilityDto
{
  @ApiProperty({ description: 'Location identifier', example: 'nbg1' })
  location: string;

  @ApiProperty({
    description:
      'Whether the server type is currently available for order in this location',
    example: true,
  })
  available: boolean;

  @ApiProperty({
    description: 'Whether the server type is deprecated in this location',
    example: false,
  })
  deprecated: boolean;
}

export class NodeSizeLocationDto implements ProviderNodeSizeLocationDto {
  @ApiProperty({ description: 'Location ID', example: 1 })
  id: number;

  @ApiProperty({ description: 'Location name', example: 'fsn1' })
  name: string;

  @ApiProperty({
    description:
      'Deprecation information for this location (null if not deprecated)',
    type: DeprecationInfoDto,
    nullable: true,
  })
  deprecation: DeprecationInfoDto | null;
}

export class NodeSizeOptionDto implements NodeSizeDto {
  @ApiProperty({ description: 'Server type ID', example: '1' })
  id: string;

  @ApiProperty({ description: 'Server type name', example: 'cx11' })
  name: string;

  @ApiProperty({ description: 'Server type description', example: 'CX11' })
  description: string;

  @ApiProperty({ description: 'Number of CPU cores', example: 1 })
  cores: number;

  @ApiProperty({ description: 'Memory in GB', example: 2 })
  memory: number;

  @ApiProperty({ description: 'Disk size in GB', example: 20 })
  disk: number;

  @ApiProperty({
    description: 'Storage type',
    enum: ['local', 'network'],
    example: 'local',
  })
  storageType: 'local' | 'network';

  @ApiProperty({
    description: 'CPU type',
    enum: ['shared', 'dedicated'],
    example: 'shared',
  })
  cpuType: 'shared' | 'dedicated';

  @ApiProperty({
    description: 'CPU architecture',
    enum: ['x86', 'arm'],
    example: 'x86',
  })
  architecture: 'x86' | 'arm';

  @ApiProperty({
    description: 'Whether the server type is deprecated',
    example: false,
  })
  deprecated: boolean;

  @ApiProperty({
    description:
      'Physical dedicated server (e.g. Scaleway Elastic Metal). Distinct from cpuType=dedicated which is a dedicated vCPU on a shared host.',
    example: false,
  })
  bareMetal: boolean;

  @ApiProperty({
    description:
      'Provider supports server-level firewall (Security Groups) for this type. False for bare metal on most providers.',
    example: true,
  })
  managedFirewall: boolean;

  @ApiProperty({
    description:
      'Pay-as-you-go hourly billing available. False = monthly commitment only, not suitable for autoscale.',
    example: true,
  })
  supportsHourlyBilling: boolean;

  @ApiProperty({
    description:
      'Monthly price per GB for block/network storage. Only present for storageType=network types (e.g. Scaleway PRO2, ENT1). Absent for local SSD types.',
    example: '0.0993',
    required: false,
    nullable: true,
  })
  blockStoragePricePerGbMonthly?: string;

  @ApiProperty({
    description: 'Prices per location',
    type: [NodeSizePriceDto],
  })
  prices: NodeSizePriceDto[];

  @ApiProperty({
    description: 'Supported locations for this server type',
    type: [NodeSizeLocationDto],
  })
  locations: NodeSizeLocationDto[];

  @ApiProperty({
    description:
      'Real-time per-location availability. Absent for providers with no live stock signal.',
    type: [NodeSizeLocationAvailabilityDto],
    required: false,
  })
  availability?: NodeSizeLocationAvailabilityDto[];
}
