import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

const STORAGE_CHOICES = ['volume', 's3'] as const;

export class EnableFluiRegistryDto {
  @ApiProperty({
    enum: STORAGE_CHOICES,
    description:
      'Where the registry keeps images: "volume" (a volume on the control cluster) or "s3" (the bucket connected with `flui registry storage connect`).',
  })
  @IsIn(STORAGE_CHOICES)
  @Sensitivity(Sensitivity.PUBLIC)
  storage: 'volume' | 's3';
}

export class RegistryModeStatusDto {
  @ApiProperty({
    enum: ['ghcr', 'flui'],
    description:
      'Where new builds push: GitHub Container Registry, or the registry Flui runs on the control cluster',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  mode: 'ghcr' | 'flui';

  @ApiProperty({
    enum: ['setting', 'install'],
    description:
      '"setting" once the registry was switched after install; "install" while the install-time choice holds',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  source: 'setting' | 'install';

  @ApiPropertyOptional({
    enum: STORAGE_CHOICES,
    nullable: true,
    description: 'Where the Flui registry keeps images; null on GHCR',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  storage: 'volume' | 's3' | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The host image references start with on the Flui registry',
  })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  host: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Every copy of the Flui registry runs its current configuration; null on GHCR',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  ready: boolean | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Why readiness could not be read, when it could not',
  })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  detail: string | null;

  @ApiProperty({ description: 'A bucket is connected for the registry' })
  @Sensitivity(Sensitivity.PUBLIC)
  bucketConnected: boolean;

  @ApiProperty({
    description: 'Applications whose builds push to the Flui registry',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  applicationsOnRegistry: number;
}
