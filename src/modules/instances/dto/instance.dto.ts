import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { InstanceType } from '../entities/instance-type.enum';
import { InstanceStatus } from '../entities/instance-status.enum';
import { InstanceOwnership } from '../entities/instance-ownership.enum';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';

export class IpAddressConfigDto {
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({ description: 'IP address' })
  ip: string;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({ description: 'Gateway address' })
  gateway: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Network mask in CIDR notation' })
  netmaskCidr: number;
}

export class IpConfigurationDto {
  // A container: the interceptor recurses into nested-DTO fields rather than
  // reading `@Sensitivity` off them, so `v4`/`v6` classify their own.
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'IPv4 configuration',
    type: IpAddressConfigDto,
    required: false,
  })
  v4?: IpAddressConfigDto;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'IPv6 configuration',
    type: IpAddressConfigDto,
    required: false,
  })
  v6?: IpAddressConfigDto;
}

export class InstanceDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Instance unique identifier' })
  id: string;

  // An opaque id, not a rendered name: nothing on a shared screen reads it and
  // recognizes who it is, which is what `tenant-identity` is for.
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'User ID who owns the instance' })
  userId: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Instance name' })
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Instance display name', required: false })
  displayName?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: InstanceType, description: 'Instance type' })
  type: InstanceType;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: CloudProvider, description: 'Cloud provider' })
  provider: CloudProvider;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Provider-specific instance ID' })
  providerId: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: InstanceStatus, description: 'Instance status' })
  status: InstanceStatus;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Data center location' })
  dataCenter: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Region identifier' })
  region: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Region display name', required: false })
  regionName?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Number of CPU cores' })
  cpuCores: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'RAM in megabytes' })
  ramMb: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Disk space in megabytes' })
  diskMb: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Operating system type', required: false })
  osType?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'IP configuration',
    type: IpConfigurationDto,
    required: false,
  })
  ipConfig?: IpConfigurationDto;

  // Not `network-identifier`: the fake generator only produces same-family
  // IPv4/IPv6 stand-ins, so routing a MAC through it would print something
  // IP-shaped in a MAC field — a worse tell than the real value.
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'MAC address', required: false })
  macAddress?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Product type', required: false })
  productType?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Product name', required: false })
  productName?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Default user for SSH access', required: false })
  defaultUser?: string;

  // One of this build's four named surfaces (MASK_MODE_DESIGN.md §3, alongside
  // `IpAddressConfigDto.ip`).
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({
    description: 'Additional IP addresses',
    type: [String],
    required: false,
  })
  additionalIps?: string[];

  // Provider-specific and untyped — there is no declared shape to classify,
  // the same reason `arbitrary-text` exists for log lines rather than a false
  // `public` promise about a blob this DTO cannot see inside.
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description: 'Additional metadata',
    required: false,
  })
  metadata?: any;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: InstanceOwnership,
    description:
      'Ownership relative to this installation: "self" if managed by this ' +
      'installation, "other-flui" if managed by another installation sharing ' +
      'the same provider account, "unmanaged" if not provisioned by flui',
    required: false,
  })
  ownership?: InstanceOwnership;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: Date;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: Date;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Cancellation date', required: false })
  cancelDate?: Date;
}
