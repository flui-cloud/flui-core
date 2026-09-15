import {
  IsString,
  IsEnum,
  IsInt,
  IsBoolean,
  IsOptional,
  IsArray,
  IsObject,
  Min,
  Max,
  MinLength,
  MaxLength,
  ValidateNested,
  IsUUID,
  IsPositive,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { AsyncOperationResponseDto } from 'src/modules/common/dto';
import { FirewallRuleDto } from 'src/modules/providers/dto/firewall.dto';
import { HostnameMode } from 'src/modules/dns/enums/hostname-mode.enum';

/**
 * DTO for VNet configuration during cluster creation
 */
export class VNetConfigDto {
  @ApiProperty({
    description: 'VNet UUID to attach cluster nodes to',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @IsUUID()
  vnetId: string;

  @ApiPropertyOptional({
    description:
      'Specific subnet UUID within the VNet. If not provided, subnet will be auto-selected.',
    example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  })
  @IsOptional()
  @IsUUID()
  subnetId?: string;

  @ApiPropertyOptional({
    description: 'Whether to auto-assign private IPs to nodes. Default: true',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  autoAssignIp?: boolean;
}

export class FluiManagedNetworkDto {
  @ApiPropertyOptional({
    description:
      'Range for the network Flui builds, if the default would collide with ' +
      'something you already run. Never derived from an address a machine ' +
      'happens to carry.',
    example: '10.250.0.0/16',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F:.]+\/\d{1,3}$/, {
    message: 'ipRange must be a CIDR, e.g. 10.250.0.0/16',
  })
  ipRange?: string;
}

export class CreateClusterDto {
  @ApiProperty({
    example: 'production-cluster',
    minLength: 3,
    maxLength: 63,
    description: 'Cluster name (must be unique)',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(63)
  name: string;

  @ApiProperty({
    enum: CloudProvider,
    example: CloudProvider.HETZNER,
    description: 'Cloud provider',
  })
  @IsEnum(CloudProvider)
  provider: CloudProvider;

  @ApiProperty({
    example: 'fsn1',
    description: 'Region/location code',
  })
  @IsString()
  region: string;

  @ApiProperty({
    example: 'cx22',
    description: 'Node size/type (applies to all nodes)',
  })
  @IsString()
  nodeSize: string;

  @ApiProperty({
    example: 2,
    minimum: 0,
    maximum: 19,
    description: 'Number of worker nodes (0 = master-only, max 19 workers)',
  })
  @IsInt()
  @Min(0)
  @Max(19)
  workerCount: number;

  @ApiPropertyOptional({
    example: false,
    description: 'Enable autoscaling',
  })
  @IsOptional()
  @IsBoolean()
  autoscalingEnabled?: boolean;

  @ApiPropertyOptional({
    example: 2,
    minimum: 1,
    description: 'Minimum number of nodes (for autoscaling)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  minNodes?: number;

  @ApiPropertyOptional({
    example: 5,
    maximum: 20,
    description: 'Maximum number of nodes (for autoscaling)',
  })
  @IsOptional()
  @IsInt()
  @Max(20)
  maxNodes?: number;

  @ApiPropertyOptional({
    example: 80,
    minimum: 50,
    maximum: 95,
    description:
      'Memory utilization percentage that triggers a scale-up. Overrides global default.',
  })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(95)
  scaleUpMemoryPct?: number;

  @ApiPropertyOptional({
    example: 75,
    minimum: 50,
    maximum: 95,
    description:
      'CPU utilization percentage that triggers a scale-up. Overrides global default.',
  })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(95)
  scaleUpCpuPct?: number;

  @ApiPropertyOptional({
    example: 300,
    minimum: 60,
    maximum: 3600,
    description:
      'Cooldown period (seconds) between consecutive scale events. Overrides global default.',
  })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(3600)
  cooldownSeconds?: number;

  @ApiPropertyOptional({
    example: 'v1.35.4+k3s1',
    description: 'K3s version (default: v1.35.4+k3s1)',
  })
  @IsOptional()
  @IsString()
  k3sVersion?: string;

  @ApiPropertyOptional({
    example: ['ssh-key-id-1', 'ssh-key-id-2'],
    description: 'SSH key IDs for node access',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sshKeys?: string[];

  @ApiPropertyOptional({
    example: 'ubuntu-24.04',
    description: 'OS image (default: ubuntu-24.04)',
  })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional({
    example: { environment: 'production', team: 'platform' },
    description: 'Additional metadata',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({
    description:
      'Firewall rules for the cluster (desired state). ' +
      'If not provided, cluster will be created with empty firewall (deny-all). ' +
      'Provide an array of firewall rules to define the cluster firewall protection.',
    type: [FirewallRuleDto],
    example: [
      {
        description: 'SSH access',
        direction: 'in',
        protocol: 'tcp',
        port: '22',
        sourceIps: ['0.0.0.0/0', '::/0'],
      },
      {
        description: 'K3s API server',
        direction: 'in',
        protocol: 'tcp',
        port: '6443',
        sourceIps: ['0.0.0.0/0', '::/0'],
      },
    ],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FirewallRuleDto)
  firewallRules?: FirewallRuleDto[];

  @ApiPropertyOptional({
    description:
      'Disk size in GB for each node. Required for node types with network storage (storageType=network, e.g. Scaleway PRO2, ENT1). ' +
      'For local SSD types the value is ignored. Minimum recommended: 20 GB.',
    example: 50,
    minimum: 1,
    maximum: 10000,
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(10000)
  diskSizeGb?: number;

  @ApiPropertyOptional({
    description:
      'VNet configuration for cluster nodes. ' +
      'If provided, all cluster nodes (master and workers) will be attached to the specified VNet. ' +
      'The VNet must exist in the same provider and region as the cluster.',
    type: VNetConfigDto,
    example: {
      vnetId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      subnetId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
      autoAssignIp: true,
    },
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => VNetConfigDto)
  vnetConfig?: VNetConfigDto;

  @ApiPropertyOptional({
    description:
      'Settings for the network Flui builds. On a provider that offers no ' +
      'private network of its own (`supportsFluiManagedVNet`) Flui builds one ' +
      'either way — every node gets an address on an encrypted mesh and K3s ' +
      'binds to it, so pod traffic stops crossing the internet in clear. This ' +
      'only chooses the range; on any other provider it is ignored.',
    type: () => FluiManagedNetworkDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => FluiManagedNetworkDto)
  fluiManagedNetwork?: FluiManagedNetworkDto;

  @ApiPropertyOptional({
    enum: HostnameMode,
    default: HostnameMode.IP,
    description:
      'Default hostname source for endpoints (system services and user apps). ' +
      'IP uses nip.io against the master public IP — zero external DNS required, ideal for testing. ' +
      'DOMAIN requires a DNS zone to be assigned to the cluster afterwards. Defaults to IP.',
  })
  @IsOptional()
  @IsEnum(HostnameMode)
  endpointHostnameMode?: HostnameMode;

  @ApiPropertyOptional({
    example: 'clever-otter-7k',
    maxLength: 30,
    description:
      'Optional token injected into nip.io system hostnames (auth/app/api). ' +
      'When omitted, a random token is generated server-side. ' +
      'Ensures each cluster has a unique LE domain set, avoiding rate limits during repeated test cycles.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  nipHostnameToken?: string;

  @ApiPropertyOptional({
    type: Boolean,
    default: true,
    description:
      'Enable Flui shared storage (NFS+fscache, see scaling doc §14). ' +
      'When true (default), the master gets an attached Volume that hosts the NFS export, ' +
      'and workers mount it via NFSv4 with cachefilesd. Disable to fall back to local-path on each node bundled disk.',
  })
  @IsOptional()
  @IsBoolean()
  sharedStorageEnabled?: boolean;

  @ApiPropertyOptional({
    type: Number,
    default: 20,
    minimum: 10,
    description:
      'Size in GB of the master backing Volume hosting the NFS export. ' +
      'Hetzner minimum is 10 GB.',
  })
  @IsOptional()
  @IsInt()
  @Min(10)
  sharedStorageVolumeSizeGb?: number;
}

/**
 * Response DTO for cluster creation request
 * Extends base async operation response with cluster-specific alias
 */
export class CreateClusterResponseDto extends AsyncOperationResponseDto {
  @ApiProperty({
    description: 'Cluster ID (alias for resource_id)',
  })
  cluster_id: string;
}
