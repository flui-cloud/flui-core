import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class StartPlatformUpdateDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'The release to move to. Must match the one currently on offer — a mismatch is refused rather than resolved, so nobody applies a release they did not read about.',
    example: '0.14.0',
  })
  @IsString()
  @IsNotEmpty()
  targetVersion: string;
}
