import { ApiProperty } from '@nestjs/swagger';
import { CANDIDATE_OUTCOMES, CandidateOutcome } from '../scaling.core';

export class PendingPodDto {
  @ApiProperty({ example: 'flui-apps/checkout-7d8f' })
  app: string;

  @ApiProperty({ example: '500m' })
  cpu: string;

  @ApiProperty({ example: '4096Mi' })
  memory: string;
}

export class LadderRungDto {
  @ApiProperty({ example: 1 })
  step: number;

  @ApiProperty({ description: 'What this rung tried' })
  describes: string;

  @ApiProperty({ nullable: true })
  shape: string | null;

  @ApiProperty({ nullable: true })
  region: string | null;

  @ApiProperty({ nullable: true, description: 'Null is unknown, never free' })
  hourlyEur: number | null;

  @ApiProperty({
    enum: CANDIDATE_OUTCOMES,
    description:
      '`refused-by-limit` is not `over-budget`: the shape is available and affordable and the group’s own rules exclude it anyway, which from the outside looks exactly like an outage.',
  })
  outcome: CandidateOutcome;

  @ApiProperty({
    required: false,
    description: 'Why this rung lost, where the outcome alone does not say it',
  })
  note?: string;
}

/** What a group would do if a node were needed right now, spending nothing. */
export class ScalingPreviewDto {
  @ApiProperty()
  groupId: string;

  @ApiProperty({
    type: PendingPodDto,
    nullable: true,
    description:
      'The largest request the scheduler could not place. Null when nothing is waiting, and null too when the cluster could not be asked — the second case is stated in `opportunityHeldBecause`.',
  })
  pending: PendingPodDto | null;

  @ApiProperty({
    nullable: true,
    description:
      'Why the patient force is standing down. Urgency always wins, and no standing order runs while a pod is waiting.',
  })
  opportunityHeldBecause: string | null;

  @ApiProperty({ type: [LadderRungDto] })
  ladder: LadderRungDto[];

  @ApiProperty({
    type: LadderRungDto,
    nullable: true,
    description: 'The rung that would win, or null when the answer is an alarm',
  })
  chosen: LadderRungDto | null;

  @ApiProperty({
    nullable: true,
    description:
      'The sentence addressed to a person, when the answer is an alarm',
  })
  asks: string | null;
}
