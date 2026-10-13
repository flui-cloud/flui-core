import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsArray,
  IsOptional,
  ValidateNested,
  IsIP,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';

export class CreateVNetSubnetDto {
  @ApiPropertyOptional({
    description:
      'Subnet IP range in CIDR notation (auto-calculated if not provided)',
    example: '10.0.1.0/24',
  })
  @IsOptional()
  @IsString()
  @Matches(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, {
    message: 'IP range must be in CIDR notation (e.g., 10.0.1.0/24)',
  })
  ipRange?: string;

  @ApiProperty({
    description: 'Network zone (e.g., eu-central, us-east)',
    example: 'eu-central',
  })
  @IsString()
  @IsNotEmpty()
  networkZone: string;

  @ApiPropertyOptional({
    description: 'Gateway IP address',
    example: '10.0.1.1',
  })
  @IsOptional()
  @IsIP()
  gateway?: string;

  @ApiPropertyOptional({
    description: 'vSwitch ID (required for vswitch type)',
    example: '12345',
  })
  @IsOptional()
  @IsString()
  vswitchId?: string;
}

export class CreateVNetRouteDto {
  @ApiProperty({
    description: 'Destination IP range in CIDR notation',
    example: '192.168.0.0/24',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, {
    message: 'Destination must be in CIDR notation (e.g., 192.168.0.0/24)',
  })
  destination: string;

  @ApiProperty({
    description: 'Gateway IP address',
    example: '10.0.0.1',
  })
  @IsIP()
  gateway: string;
}

export class CreateVNetDto {
  @ApiProperty({
    description: 'VNet name',
    example: 'my-vnet',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'Cloud provider',
    enum: CloudProvider,
    example: CloudProvider.HETZNER,
  })
  @IsEnum(CloudProvider)
  provider: CloudProvider;

  @ApiProperty({
    description: 'VNet IP range in CIDR notation',
    example: '10.0.0.0/16',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, {
    message: 'IP range must be in CIDR notation (e.g., 10.0.0.0/16)',
  })
  ipRange: string;

  @ApiPropertyOptional({
    description:
      'Network zone the VNet is created in, one of the zones the provider ' +
      'declares (e.g. nl-ams). Servers can join only from the regions it covers.',
    example: 'nl-ams',
  })
  @IsOptional()
  @IsString()
  networkZone?: string;

  @ApiPropertyOptional({
    description: 'Subnets to create within the VNet',
    type: [CreateVNetSubnetDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateVNetSubnetDto)
  subnets?: CreateVNetSubnetDto[];

  @ApiPropertyOptional({
    description: 'Routes to create within the VNet',
    type: [CreateVNetRouteDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateVNetRouteDto)
  routes?: CreateVNetRouteDto[];

  @ApiPropertyOptional({
    description: 'Labels for the VNet',
    example: [{ key: 'environment', value: 'production' }],
  })
  @IsOptional()
  @IsArray()
  labels?: Array<{ key: string; value: string }>;

  @ApiPropertyOptional({
    description: 'Additional metadata',
    example: { clusterId: '123e4567-e89b-12d3-a456-426614174000' },
  })
  @IsOptional()
  metadata?: Record<string, any>;
}
