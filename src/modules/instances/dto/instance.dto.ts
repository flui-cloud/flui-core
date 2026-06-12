import { ApiProperty } from '@nestjs/swagger';
import { InstanceType } from '../entities/instance-type.enum';
import { InstanceStatus } from '../entities/instance-status.enum';
import { InstanceOwnership } from '../entities/instance-ownership.enum';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';

export class IpAddressConfigDto {
  @ApiProperty({ description: 'IP address' })
  ip: string;

  @ApiProperty({ description: 'Gateway address' })
  gateway: string;

  @ApiProperty({ description: 'Network mask in CIDR notation' })
  netmaskCidr: number;
}

export class IpConfigurationDto {
  @ApiProperty({
    description: 'IPv4 configuration',
    type: IpAddressConfigDto,
    required: false,
  })
  v4?: IpAddressConfigDto;

  @ApiProperty({
    description: 'IPv6 configuration',
    type: IpAddressConfigDto,
    required: false,
  })
  v6?: IpAddressConfigDto;
}

export class InstanceDto {
  @ApiProperty({ description: 'Instance unique identifier' })
  id: string;

  @ApiProperty({ description: 'User ID who owns the instance' })
  userId: string;

  @ApiProperty({ description: 'Instance name' })
  name: string;

  @ApiProperty({ description: 'Instance display name', required: false })
  displayName?: string;

  @ApiProperty({ enum: InstanceType, description: 'Instance type' })
  type: InstanceType;

  @ApiProperty({ enum: CloudProvider, description: 'Cloud provider' })
  provider: CloudProvider;

  @ApiProperty({ description: 'Provider-specific instance ID' })
  providerId: string;

  @ApiProperty({ enum: InstanceStatus, description: 'Instance status' })
  status: InstanceStatus;

  @ApiProperty({ description: 'Data center location' })
  dataCenter: string;

  @ApiProperty({ description: 'Region identifier' })
  region: string;

  @ApiProperty({ description: 'Region display name', required: false })
  regionName?: string;

  @ApiProperty({ description: 'Number of CPU cores' })
  cpuCores: number;

  @ApiProperty({ description: 'RAM in megabytes' })
  ramMb: number;

  @ApiProperty({ description: 'Disk space in megabytes' })
  diskMb: number;

  @ApiProperty({ description: 'Operating system type', required: false })
  osType?: string;

  @ApiProperty({
    description: 'IP configuration',
    type: IpConfigurationDto,
    required: false,
  })
  ipConfig?: IpConfigurationDto;

  @ApiProperty({ description: 'MAC address', required: false })
  macAddress?: string;

  @ApiProperty({ description: 'Product type', required: false })
  productType?: string;

  @ApiProperty({ description: 'Product name', required: false })
  productName?: string;

  @ApiProperty({ description: 'Default user for SSH access', required: false })
  defaultUser?: string;

  @ApiProperty({
    description: 'Additional IP addresses',
    type: [String],
    required: false,
  })
  additionalIps?: string[];

  @ApiProperty({
    description: 'Additional metadata',
    required: false,
  })
  metadata?: any;

  @ApiProperty({
    enum: InstanceOwnership,
    description:
      'Ownership relative to this installation: "self" if managed by this ' +
      'installation, "other-flui" if managed by another installation sharing ' +
      'the same provider account, "unmanaged" if not provisioned by flui',
    required: false,
  })
  ownership?: InstanceOwnership;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: Date;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: Date;

  @ApiProperty({ description: 'Cancellation date', required: false })
  cancelDate?: Date;
}
