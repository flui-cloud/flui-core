import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../../mask/decorators/sensitivity.decorator';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CANDIDATE_OUTCOMES, CandidateOutcome } from '../scaling.core';
import { WHAT_IF_VERDICTS, WhatIfVerdict } from '../engine/what-if.core';
import { ALARM_EXIT_KINDS, AlarmExitKind } from '../engine/engine.core';

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
    description:
      'What the same apps may grow to, each at its limit (its request where it sets none)',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  limits: RoomAmountDto;

  @ApiProperty({
    type: RoomAmountDto,
    nullable: true,
    description: 'What they use right now; null when usage could not be read',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  used: RoomAmountDto | null;

  @ApiProperty({
    type: [String],
    description: 'The applications with a replica on this node',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  apps: string[];

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

export class AlarmExitDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ALARM_EXIT_KINDS })
  kind: AlarmExitKind;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 'Raise the cap to €30' })
  label: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    description:
      'raise-cap: the smallest monthly ceiling that lets the nearest machine through',
  })
  toEur: number | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    description: 'raise-max-nodes: the ceiling to set',
  })
  toNodes: number | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    description:
      'add-shape: a machine the group does not name that would be bought now',
  })
  shape: string | null;
}

export class AlarmBlockDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 'Scaling needed — blocked by the spend cap' })
  headline: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [AlarmExitDto] })
  exits: AlarmExitDto[];
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

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: AlarmBlockDto,
    nullable: true,
    description:
      'When nothing would be bought: the main block in one headline and the ways out, each computed (the ceiling that is enough, the machine that would work). `asks` stays the long form.',
  })
  blocked: AlarmBlockDto | null;

  @ApiProperty({
    type: FleetRoomDto,
    nullable: true,
    description:
      'How much room each node has left for new apps, counted the way the scheduler counts it: what apps reserve, not what they use. Null when the cluster could not be asked.',
  })
  room: FleetRoomDto | null;
}

export class WhatIfRequestDto {
  @ApiProperty({ example: '500m', description: 'CPU each replica reserves' })
  @IsString()
  @Sensitivity(Sensitivity.PUBLIC)
  cpu: string;

  @ApiProperty({ example: '2Gi', description: 'Memory each replica reserves' })
  @IsString()
  @Sensitivity(Sensitivity.PUBLIC)
  memory: string;

  @ApiPropertyOptional({ example: 1, minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  @Sensitivity(Sensitivity.PUBLIC)
  replicas?: number;
}

export class MachineRoomDto {
  @ApiProperty({
    nullable: true,
    description: 'The machine type, or null for a node already in the cluster',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  shape: string | null;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  cpuMillicores: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  memoryMi: number;
}

export class WhatIfAnswerDto {
  @ApiProperty({
    enum: WHAT_IF_VERDICTS,
    description:
      '`fits`: room on a node already there. `buys`: an automatic group would buy `shape` in `region`. `proposes`: a manual group would name that machine and buy nothing. `nothing-hosts`: no machine the group may buy can take it, so the app would wait. `unknown`: the cluster could not be asked.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  verdict: WhatIfVerdict;

  @ApiProperty({ description: 'The consequence in one sentence' })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  sentence: string;

  @ApiProperty({ nullable: true, description: 'The node it would run on' })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  node: string | null;

  @ApiProperty({ nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  groupId: string | null;

  @ApiProperty({ nullable: true, enum: ['automatic', 'manual'] })
  @Sensitivity(Sensitivity.PUBLIC)
  provision: 'automatic' | 'manual' | null;

  @ApiProperty({ nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  shape: string | null;

  @ApiProperty({ nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  region: string | null;

  @ApiProperty({ nullable: true, description: 'Null is unknown, never free' })
  @Sensitivity(Sensitivity.PUBLIC)
  monthlyEur: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Why no machine can take it, machine by machine',
  })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  why: string | null;

  @ApiProperty({
    type: MachineRoomDto,
    nullable: true,
    description:
      'The largest single replica anything could hold: the biggest node already there or the biggest machine a group may buy inside its money ceiling',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  largest: MachineRoomDto | null;
}
