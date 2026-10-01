import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { NOTE_MAX } from '../utils/app-backup-decision.rules';

export class SetBackupDecisionDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'True: Flui stops asking for a backup of this application. False: it is backed up again. Backups already taken and the policies naming it are left as they are.',
  })
  @IsBoolean()
  notBackedUp: boolean;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({
    maxLength: NOTE_MAX,
    description:
      'Why, in a few words. Shown wherever the application is listed as not backed up.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX)
  note?: string;
}
