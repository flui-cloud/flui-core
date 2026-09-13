import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { ProvisionerCapability } from '../../storage/interfaces/object-storage-provisioner.interface';

export class ObjectStorageRegionOptionDto {
  @ApiProperty()
  value: string;

  @ApiProperty()
  label: string;

  @ApiProperty()
  endpoint: string;
}

export class ObjectStoragePresetDto {
  @ApiProperty({ enum: StorageBackendProvider })
  provider: StorageBackendProvider;

  @ApiProperty()
  label: string;

  @ApiProperty()
  description: string;

  @ApiPropertyOptional()
  badge?: string;

  @ApiPropertyOptional({
    description: 'Absent for targets whose endpoint the operator supplies.',
  })
  defaultRegion?: string;

  @ApiPropertyOptional()
  defaultEndpoint?: string;

  @ApiProperty()
  forcePathStyle: boolean;

  @ApiProperty()
  usableForEtcdL1: boolean;

  @ApiProperty({
    enum: ProvisionerCapability,
    description: 'How much of the setup Flui can perform on its own.',
  })
  provisioning: ProvisionerCapability;

  @ApiPropertyOptional({ type: [ObjectStorageRegionOptionDto] })
  regions?: ObjectStorageRegionOptionDto[];
}
