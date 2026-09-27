import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class UpgradeDestinationLayoutDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'Switch even though cluster backups are stored at the top: they stay in the bucket but are no longer listed or restorable until moved into velero/.',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
