import { IsOptional, IsString, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { InstanceType } from '../entities/instance-type.enum';
import { InstanceStatus } from '../entities/instance-status.enum';
import { InstanceOwnership } from '../entities/instance-ownership.enum';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';

export class InstanceFiltersDto {
  @ApiPropertyOptional({
    enum: InstanceType,
    description: 'Filter by instance type',
  })
  @IsOptional()
  @IsEnum(InstanceType)
  type?: InstanceType;

  @ApiPropertyOptional({
    enum: InstanceStatus,
    description: 'Filter by instance status',
  })
  @IsOptional()
  @IsEnum(InstanceStatus)
  status?: InstanceStatus;

  @ApiPropertyOptional({
    enum: CloudProvider,
    description: 'Filter by cloud provider',
  })
  @IsOptional()
  @IsEnum(CloudProvider)
  provider?: CloudProvider;

  @ApiPropertyOptional({ description: 'Filter by region' })
  @IsOptional()
  @IsString()
  region?: string;

  @ApiPropertyOptional({ description: 'Filter by data center' })
  @IsOptional()
  @IsString()
  dataCenter?: string;

  @ApiPropertyOptional({ description: 'Search by name or display name' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by cluster ID (from flui-cluster-id label)',
  })
  @IsOptional()
  @IsString()
  clusterId?: string;

  @ApiPropertyOptional({
    enum: InstanceOwnership,
    description:
      'Filter by ownership relative to this installation (self / other-flui / unmanaged)',
  })
  @IsOptional()
  @IsEnum(InstanceOwnership)
  ownership?: InstanceOwnership;
}
