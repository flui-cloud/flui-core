import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { Sensitivity } from '../../../mask/decorators/sensitivity.decorator';

export class RebuildClusterDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'The live cluster to re-materialise the applications onto',
  })
  @IsUUID()
  to: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'Also rebuild applications that were not running when the cluster was lost. ' +
      'Off by default: a stopped application is brought back stopped-shaped, ' +
      'which is rarely what a recovery wants without saying so.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  includeStopped?: boolean;
}

export class RebuildClusterSideDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  status: string;
}

export class RebuildPlanAppDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  applicationId: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  name: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  slug: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  status: string;

  // Names the node it was pinned to, which is a machine name.
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({ description: 'Set when it cannot be rebuilt at all' })
  blocked?: string;

  // Quote volume names and copy paths back to the reader.
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ type: [String] })
  warnings: string[];

  // Quote copy paths and snapshot ids back to the reader.
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    type: [String],
    description: 'What comes back, and from where',
  })
  restores: string[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ description: 'Where a previous run got to' })
  phase?: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({
    type: [String],
    description:
      'Applications rebuilt before this one because it uses them — a database before the application reading it',
  })
  after?: string[];
}

export class RebuildCapacityDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  requiredCpuMillis: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  requiredMemoryMi: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  availableCpuMillis: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  availableMemoryMi: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  fits: boolean;
}

export class RebuildPlanResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: ['workload', 'control'],
    description:
      '`control` when the applications come back onto this installation’s own control cluster',
  })
  mode: 'workload' | 'control';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: RebuildClusterSideDto })
  from: RebuildClusterSideDto;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: RebuildClusterSideDto })
  to: RebuildClusterSideDto;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [RebuildPlanAppDto] })
  apps: RebuildPlanAppDto[];

  // Name the clusters and quote their state back.
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    type: [String],
    description: 'Empty means the rebuild can start',
  })
  refusals: string[];

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    type: [String],
    description: 'True of the whole rebuild and not disqualifying',
  })
  warnings: string[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ type: RebuildCapacityDto })
  capacity?: RebuildCapacityDto;
}

export class RebuildClusterResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  operation_id: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  status: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'How many applications the rebuild will attempt',
  })
  applications: number;
}

export class ControlRestoreDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'The earlier control cluster to restore from. Needed only when more than one still has applications recorded on it.',
  })
  @IsOptional()
  @IsUUID()
  from?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'Also restore applications that were not running when that control cluster was lost',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  includeStopped?: boolean;
}

export class PreviousControlDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  status: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'Retired by the restore, deleted, or marked lost',
  })
  retired: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Applications still recorded on it' })
  applications: number;
}

export class ControlRestorePlanResponseDto extends RebuildPlanResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [PreviousControlDto] })
  candidates: PreviousControlDto[];
}
