import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { WhatIfAnswerDto } from '../../infrastructure/scaling/dto/scaling-preview.dto';

// ── Request DTOs ──────────────────────────────────────────────────────────────

export class ContainerResourceSpecDto {
  @ApiPropertyOptional({
    example: '500m',
    description: 'CPU quantity (e.g. "250m", "1", "2")',
  })
  @IsOptional()
  @IsString()
  cpu?: string;

  @ApiPropertyOptional({
    example: '256Mi',
    description: 'Memory quantity (e.g. "128Mi", "1Gi")',
  })
  @IsOptional()
  @IsString()
  memory?: string;
}

export class UpdateResourcesDto {
  @ApiPropertyOptional({
    type: ContainerResourceSpecDto,
    description: 'Resource requests (guaranteed minimums)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ContainerResourceSpecDto)
  requests?: ContainerResourceSpecDto;

  @ApiPropertyOptional({
    type: ContainerResourceSpecDto,
    description: 'Resource limits (hard ceilings)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ContainerResourceSpecDto)
  limits?: ContainerResourceSpecDto;

  @ApiPropertyOptional({
    example: 'app',
    description:
      'Name of the container to update. Defaults to the first container if omitted.',
  })
  @IsOptional()
  @IsString()
  containerName?: string;
}

export class UpdateReplicasDto {
  @ApiProperty({
    example: 2,
    minimum: 0,
    maximum: 20,
    description: 'Desired replica count (0 = stopped)',
  })
  @IsInt()
  @Min(0)
  @Max(20)
  replicas: number;
}

// ── Response DTOs ─────────────────────────────────────────────────────────────

export class ContainerResourcesDto {
  @ApiPropertyOptional({ example: '500m' })
  cpu: string | null;

  @ApiPropertyOptional({ example: '256Mi' })
  memory: string | null;
}

export class ContainerRuntimeDetailDto {
  @ApiProperty({ example: 'app' })
  name: string;

  @ApiProperty({ example: 'nginx:1.25' })
  image: string;

  @ApiProperty({ type: ContainerResourcesDto })
  requests: ContainerResourcesDto;

  @ApiProperty({ type: ContainerResourcesDto })
  limits: ContainerResourcesDto;

  @ApiPropertyOptional({
    type: ContainerResourcesDto,
    description: 'Live usage from metrics-server (null if not available)',
  })
  usage?: ContainerResourcesDto;
}

export class ReplicaStatusDto {
  @ApiPropertyOptional({ example: 2 })
  desired?: number;

  @ApiPropertyOptional({ example: 2 })
  ready?: number;

  @ApiPropertyOptional({ example: 2 })
  available?: number;

  @ApiPropertyOptional({ example: 0 })
  unavailable?: number;

  @ApiPropertyOptional({ example: 2 })
  updated?: number;
}

export class RoomWaitDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 1, description: 'Replicas no node has room for yet' })
  replicas: number;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    example:
      '4 requested · 3 running · 1 waiting for a new node — the group is manual: it would propose a cpx22 in fsn1 and buy nothing until a person does.',
  })
  says: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    enum: ['fits', 'buys', 'proposes', 'nothing-hosts', 'unknown'],
    description: 'What scaling does about it, as the what-if answer names it',
  })
  verdict: string | null;
}

export class PodPlacementDto {
  @ApiProperty({ example: 'my-app-7d8f-abcde' })
  @Sensitivity(Sensitivity.PUBLIC)
  name: string;

  @ApiProperty({
    nullable: true,
    description: 'The node it runs on; null while it waits for one',
  })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  node: string | null;

  @ApiProperty({ nullable: true, enum: ['master', 'worker'] })
  @Sensitivity(Sensitivity.PUBLIC)
  role: 'master' | 'worker' | null;

  @ApiProperty({
    nullable: true,
    description: 'Machine type of that node, where the provider has one',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  serverType: string | null;

  @ApiProperty({ nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  region: string | null;

  @ApiProperty({ example: 'Running' })
  @Sensitivity(Sensitivity.PUBLIC)
  phase: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  ready: boolean;
}

export class AppRuntimeResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  appId: string;

  @ApiProperty({ example: 'my-app' })
  deploymentName: string;

  @ApiProperty({ example: 'default' })
  namespace: string;

  @ApiProperty({ type: ReplicaStatusDto })
  replicas: ReplicaStatusDto;

  @ApiProperty({ type: [ContainerRuntimeDetailDto] })
  containers: ContainerRuntimeDetailDto[];

  @ApiPropertyOptional({
    type: [PodPlacementDto],
    description:
      'Each replica and the node it runs on, or null while it waits for room',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  pods?: PodPlacementDto[];

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Set when saved variables have not reached the running pods yet: a restart applies them. `changes` names each variable (added / changed / removed), never a value.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  restartPending?: { changes: string[] } | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    type: RoomWaitDto,
    nullable: true,
    description:
      'Set when some replicas wait for a node with room: that is a wait, not a failure, and it lasts as long as scaling takes.',
  })
  waitingForRoom?: RoomWaitDto | null;
}

export class ResourcesConsequenceDto {
  @ApiProperty({
    type: ContainerResourcesDto,
    description: 'The requests that would be written, as they would be written',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  requests: ContainerResourcesDto;

  @ApiProperty({
    type: ContainerResourcesDto,
    description: 'The limits that would be written, as they would be written',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  limits: ContainerResourcesDto;

  @ApiProperty({
    nullable: true,
    description: 'Why this would be refused, such as a limit below its request',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  problem: string | null;

  @ApiProperty({
    type: WhatIfAnswerDto,
    description: 'Where the replicas would run with these requests',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  placement: WhatIfAnswerDto;
}
