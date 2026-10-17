import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { Sensitivity } from 'src/modules/mask/decorators/sensitivity.decorator';
import { ServerArchitecture } from 'src/modules/providers/core/catalogue/server-architecture';

export class LabelDto {
  @ApiProperty()
  key: string;

  @ApiProperty()
  value: string;
}

export class VNetAttachmentDto {
  @ApiProperty({
    description: 'VNet UUID',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  vnetId: string;

  @ApiProperty({ description: 'VNet name', example: 'production-vnet' })
  vnetName: string;

  @ApiProperty({
    description: 'Subnet UUID',
    example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  })
  subnetId: string;

  @ApiProperty({
    description: 'Private IP address in VNet',
    example: '10.0.1.5',
  })
  ip: string;

  @ApiPropertyOptional({
    description: 'Alias IP addresses',
    type: [String],
    example: ['10.0.1.10', '10.0.1.11'],
  })
  aliasIps?: string[];

  @ApiPropertyOptional({
    description: 'Provider-specific VNet resource ID',
    example: '12345678',
  })
  providerVnetId?: string;
}

export class ServerResponseDto {
  @ApiProperty({ description: 'Server unique identifier' })
  id: string;

  @ApiProperty({ description: 'Server name' })
  name: string;

  @ApiProperty({ enum: CloudProvider, description: 'Cloud provider' })
  provider: CloudProvider;

  @ApiProperty({ description: 'Provider-specific resource ID' })
  provider_resource_id: string;

  @ApiProperty({ description: 'Server type/size' })
  server_type: string;

  @ApiPropertyOptional({
    enum: ['x86', 'arm'],
    nullable: true,
    description:
      'CPU architecture of the server type; null where the provider does not say',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  architecture?: ServerArchitecture | null;

  @ApiProperty({ description: 'Server location/datacenter' })
  location: string;

  @ApiProperty({ description: 'Current server status' })
  status: string;

  @ApiPropertyOptional({ description: 'Public IP address' })
  public_ip?: string;

  @ApiPropertyOptional({ description: 'Private IP address' })
  private_ip?: string;

  @ApiProperty({ description: 'Server creation date' })
  created_at: Date;

  @ApiProperty({ description: 'Last update timestamp' })
  updated_at: Date;

  @ApiPropertyOptional({ description: 'Last sync timestamp from provider' })
  lastSyncAt?: Date;

  @ApiPropertyOptional({
    description: 'Server labels/tags',
    type: [LabelDto],
    example: [
      { key: 'managed-by', value: 'flui-cloud' },
      { key: 'environment', value: 'production' },
    ],
  })
  labels?: LabelDto[];

  @ApiPropertyOptional({
    description: 'VNet attachments for this server',
    type: [VNetAttachmentDto],
    example: [
      {
        vnetId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        vnetName: 'production-vnet',
        subnetId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
        ip: '10.0.1.5',
        aliasIps: ['10.0.1.10'],
        providerVnetId: '12345678',
      },
    ],
  })
  vnetAttachments?: VNetAttachmentDto[];
}
