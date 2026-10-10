import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from 'class-validator';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

const SCALEWAY_REGIONS = ['fr-par', 'nl-ams', 'pl-waw'] as const;

export class ConnectScalewayRegistryStorageDto {
  @ApiProperty({
    description:
      'Scaleway region of the bucket. Flui creates a project, an Object Storage-only key and the bucket there, with the Scaleway key this installation already holds.',
    enum: SCALEWAY_REGIONS,
    example: 'fr-par',
  })
  @IsIn(SCALEWAY_REGIONS)
  @Sensitivity(Sensitivity.PUBLIC)
  region: string;
}

const OWN_BUCKET_PROVIDERS = [
  StorageBackendProvider.OVH_OBJECT_STORAGE,
  StorageBackendProvider.SCALEWAY_OBJECT_STORAGE,
  StorageBackendProvider.GENERIC_S3,
  StorageBackendProvider.MINIO,
] as const;

export class ConnectRegistryStorageDto {
  @ApiProperty({ enum: OWN_BUCKET_PROVIDERS })
  @IsIn(OWN_BUCKET_PROVIDERS)
  @Sensitivity(Sensitivity.PUBLIC)
  provider: StorageBackendProvider;

  @ApiProperty({ example: 'https://s3.gra.io.cloud.ovh.net' })
  @IsUrl({ require_tld: false, protocols: ['https', 'http'] })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  endpoint: string;

  @ApiProperty({ example: 'gra' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Sensitivity(Sensitivity.PUBLIC)
  region: string;

  @ApiProperty({ example: 'flui-registry' })
  @Matches(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  bucket: string;

  @ApiPropertyOptional({ example: 'zot', default: 'zot' })
  @IsOptional()
  @Matches(/^[A-Za-z0-9._/-]{1,200}$/)
  @Sensitivity(Sensitivity.PUBLIC)
  prefix?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  @Sensitivity(Sensitivity.PUBLIC)
  forcePathStyle?: boolean;

  @ApiProperty({
    description:
      'Access key that reaches this bucket and nothing else: never an account key, never the backups credential.',
  })
  @IsString()
  @IsNotEmpty()
  @Sensitivity(Sensitivity.CREDENTIAL)
  accessKey: string;

  @ApiProperty({ description: 'Secret key paired with accessKey.' })
  @IsString()
  @IsNotEmpty()
  @Sensitivity(Sensitivity.CREDENTIAL)
  secretKey: string;
}

export class RegistryApplicationUsageDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  applicationId: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  name: string;

  @ApiProperty({
    description:
      'Bytes its images take; a layer shared with another application counts in both',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  bytes: number;
}

export class RegistryUsageDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  measuredAt: Date;

  @ApiProperty({
    description:
      'Bytes the registry keeps, each layer once however many applications share it',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  totalBytes: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Where the space alert is raised; null when it is off',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  alertBytes: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "The volume's size; null on a bucket, which never fills",
  })
  @Sensitivity(Sensitivity.PUBLIC)
  capacityBytes: number | null;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  alerting: boolean;

  @ApiProperty({ type: [RegistryApplicationUsageDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  applications: RegistryApplicationUsageDto[];

  @ApiProperty({
    description: 'Applications whose images could not be read on this pass',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  unreadable: number;
}

export class RegistryStorageStatusDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  connected: boolean;

  @ApiPropertyOptional({ enum: StorageBackendProvider })
  @Sensitivity(Sensitivity.PUBLIC)
  provider?: StorageBackendProvider;

  @ApiPropertyOptional()
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  endpoint?: string;

  @ApiPropertyOptional()
  @Sensitivity(Sensitivity.PUBLIC)
  region?: string;

  @ApiPropertyOptional()
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  bucket?: string;

  @ApiPropertyOptional()
  @Sensitivity(Sensitivity.PUBLIC)
  connectedAt?: Date;

  @ApiProperty({
    description:
      'Where the registry keeps images: "filesystem" (a volume on the control cluster) or "s3" (the connected bucket).',
    enum: ['filesystem', 's3'],
  })
  @Sensitivity(Sensitivity.PUBLIC)
  backend: 'filesystem' | 's3';

  @ApiPropertyOptional({
    type: RegistryUsageDto,
    description:
      'The space in use, measured every 30 minutes; absent while the instance keeps images on GHCR',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  usage?: RegistryUsageDto;
}

export class RegistryBucketDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  id: string;

  @ApiProperty({ enum: StorageBackendProvider })
  @Sensitivity(Sensitivity.PUBLIC)
  provider: StorageBackendProvider;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  region: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  bucket: string;

  @ApiProperty({ description: 'The bucket the registry is pointed at' })
  @Sensitivity(Sensitivity.PUBLIC)
  active: boolean;

  @ApiProperty({
    description:
      'Flui created it: removing it deletes the bucket, its images and what was created around it',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  createdByFlui: boolean;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  connectedAt: Date;
}

export class RegistryBucketRemovalDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  bucket: string;

  @ApiProperty({
    description:
      'False for a bucket of your own: only Flui forgets it, its content stays',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  bucketDeleted: boolean;
}
