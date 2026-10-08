import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import type { HeartbeatState } from '../schedulers/master-heartbeat.scheduler';

export class HeartbeatStatusDto {
  @ApiProperty({
    enum: ['off', 'beating', 'withheld', 'failing'],
    description:
      'off: no heartbeat address is set. beating: the last check passed and the beat went out. withheld: something is wrong, so the outside watchdog is left to alarm. failing: the beat could not be delivered.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  state: HeartbeatState;

  @ApiProperty({ type: String, nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  lastCheckAt: string | null;

  @ApiProperty({ type: String, nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  lastBeatAt: string | null;

  @ApiProperty({
    type: [String],
    description: 'Why the last beat was withheld or failed',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  reasons: string[];
}
