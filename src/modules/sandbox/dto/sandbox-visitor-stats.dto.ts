import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class SandboxVisitorRefusalCountDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'closed, limit-ip, limit-cli, limit-global, limit-day, challenge, invalid, no-admission or error',
  })
  reason: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  count: number;
}

export class SandboxVisitorDayDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Visitors that came in' })
  created: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Visitors turned away, all reasons' })
  refused: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [SandboxVisitorRefusalCountDto] })
  refusedByReason: SandboxVisitorRefusalCountDto[];
}

export class SandboxVisitorStatsDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'The visitors’ entrance takes new visitors' })
  entranceOpen: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Visitors in the demo now' })
  visitorsNow: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'Visitors made ahead of time, ready to hand out',
  })
  poolReady: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'How many are kept ready' })
  poolMin: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Visitors that became an account, all time' })
  upgraded: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'Visitors added to an account that existed, all time',
  })
  merged: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: SandboxVisitorDayDto, description: 'The last 24 hours' })
  last24h: SandboxVisitorDayDto;
}
