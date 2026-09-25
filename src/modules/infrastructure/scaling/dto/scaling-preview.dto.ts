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
export class RoomAmountDto {
  @ApiProperty()
  cpuMillicores: number;

  @ApiProperty()
  memoryMi: number;
}

export class NodeRoomDto {
  @ApiProperty()
  name: string;

  @ApiProperty({ enum: ['master', 'worker'] })
  role: 'master' | 'worker';

  @ApiProperty({
    description:
      'Whether new apps may be placed here: ready, not cordoned, not refusing work',
  })
  takesWork: boolean;

  @ApiProperty({ type: RoomAmountDto, description: 'What the node can hold' })
  allocatable: RoomAmountDto;

  @ApiProperty({ type: RoomAmountDto, description: 'What apps reserve on it' })
  requested: RoomAmountDto;

  @ApiProperty({
    type: RoomAmountDto,
    description: 'What is left for new apps, after the system reserve',
  })
  free: RoomAmountDto;
}

export class LargestFitDto extends RoomAmountDto {
  @ApiProperty({ description: 'The node that has it' })
  node: string;
}

export class FleetRoomDto {
  @ApiProperty({ type: [NodeRoomDto] })
  nodes: NodeRoomDto[];

  @ApiProperty({
    type: LargestFitDto,
    nullable: true,
    description:
      'The largest app that still fits without buying a node. Null when no node takes work.',
  })
  largestFit: LargestFitDto | null;
}

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
      'Why the patient force is standing down. Urgency always wins, and no standing order runs while an app is waiting to run.',
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

  @ApiProperty({
    type: FleetRoomDto,
    nullable: true,
    description:
      'How much room each node has left for new apps, counted the way the scheduler counts it: what apps reserve, not what they use. Null when the cluster could not be asked.',
  })
  room: FleetRoomDto | null;
}
