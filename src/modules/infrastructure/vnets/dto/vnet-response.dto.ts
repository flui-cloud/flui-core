import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { VNetStatus } from '../entities/vnet.entity';
import { Sensitivity } from '../../../mask/decorators/sensitivity.decorator';

export class VNetSubnetResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Subnet ID' })
  id: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ description: 'Provider-specific subnet ID' })
  providerSubnetId?: string;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({ description: 'Subnet IP range' })
  ipRange: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Network zone' })
  networkZone: string;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiPropertyOptional({ description: 'Gateway IP address' })
  gateway?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ description: 'vSwitch ID' })
  vswitchId?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'List of server IDs attached to this subnet',
    type: [String],
    example: ['12345678', '87654321'],
  })
  attachedServerIds: string[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: Date;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: Date;
}

export class VNetRouteResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Route ID' })
  id: string;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({ description: 'Destination IP range' })
  destination: string;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({ description: 'Gateway IP address' })
  gateway: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: Date;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: Date;
}

export class VNetResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'VNet ID' })
  id: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Provider resource ID' })
  providerResourceId: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'VNet name' })
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Cloud provider', enum: CloudProvider })
  provider: CloudProvider;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({ description: 'VNet IP range' })
  ipRange: string;

  // User-set free-form key/value pairs — no established provenance discipline,
  // never substituted, same treatment InstanceDto.metadata already gets.
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description: 'Labels',
    type: 'array',
    items: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
      },
    },
  })
  labels: Array<{ key: string; value: string }>;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({ description: 'Additional metadata' })
  metadata?: Record<string, any>;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'VNet status', enum: VNetStatus })
  status: VNetStatus;

  // Nested DTO array: the interceptor recurses via VNetSubnetResponseDto's own
  // decorators regardless of this value — present only so the sentinel sees every
  // @ApiProperty field decorated, matching InstanceDto.ipConfig's precedent.
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'Subnets',
    type: [VNetSubnetResponseDto],
  })
  subnets: VNetSubnetResponseDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'Routes',
    type: [VNetRouteResponseDto],
  })
  routes: VNetRouteResponseDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: Date;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: Date;
}

export class VNetListResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'List of VNets',
    type: [VNetResponseDto],
  })
  vnets: VNetResponseDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Total count' })
  total: number;
}
