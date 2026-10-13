import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class SandboxTestVisitorDto {
  @ApiProperty({ example: '6f1c2a8e-1d3b-4f5a-9c7e-2b8d4e6f0a1c' })
  userId: string;

  @ApiProperty({ example: '339012345678901234' })
  idpUserId: string;

  @ApiProperty({ example: 'visitor-1a2b3c4d' })
  username: string;

  @Sensitivity(Sensitivity.CREDENTIAL, { conditional: true })
  @ApiProperty({
    description:
      'A key that acts as the visitor, carrying only the reading groups. Shown once; it expires after a day.',
  })
  apiKey: string;

  @ApiProperty({ example: ['apps:look', 'observability:look'] })
  groups: string[];
}
