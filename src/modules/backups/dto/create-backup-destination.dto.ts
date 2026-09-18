import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsInt,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { EncryptionMode } from '../enums/destination-health.enum';

export class CreateBackupDestinationDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiProperty({ enum: StorageBackendProvider })
  @IsEnum(StorageBackendProvider)
  provider: StorageBackendProvider;

  // These four are substituted into places that are not YAML and cannot be
  // fixed by emitting YAML properly: a pgBackRest INI built by joining lines,
  // and a systemd drop-in written on the master. In both, a newline is a new
  // directive — `repo1-host-cmd` in the first, `ExecStartPre=` running as root
  // in the second. So they are constrained here, at the only door they come
  // through, rather than escaped at each sink.
  @ApiProperty({ example: 'https://fsn1.your-objectstorage.com' })
  @IsString()
  @MaxLength(255)
  @Matches(/^[A-Za-z0-9._:/-]+$/, {
    message: 'endpoint may not contain whitespace or control characters',
  })
  endpoint: string;

  @ApiProperty({ example: 'fsn1' })
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9-]+$/, {
    message: 'region may contain only letters, digits and hyphens',
  })
  region: string;

  // No slash: S3 bucket names never contain one, and rclone addresses an object
  // as `bucket/prefix` — a slash here is that separator, moved.
  @ApiProperty({ example: 'flui-backups-0a1b2c3d4e5f' })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, {
    message:
      'bucket must be 3-63 characters of lowercase letters, digits, dots and hyphens',
  })
  bucket: string;

  @ApiPropertyOptional({ example: 'flui/3f29f52b' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/^[A-Za-z0-9._/-]*$/, {
    message:
      'pathPrefix may contain only letters, digits, dots, underscores, slashes and hyphens',
  })
  pathPrefix?: string;

  @ApiProperty()
  @IsString()
  accessKey: string;

  @ApiProperty()
  @IsString()
  secretKey: string;

  @ApiPropertyOptional({ enum: EncryptionMode })
  @IsOptional()
  @IsEnum(EncryptionMode)
  encryptionMode?: EncryptionMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  encryptionPassphrase?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  forcePathStyle?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  useSse?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  usableForEtcdL1?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  costPerGbMonthCents?: number;
}
