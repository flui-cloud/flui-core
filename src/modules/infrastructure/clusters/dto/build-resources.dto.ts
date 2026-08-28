import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type BuildResourceStatus =
  | 'ok'
  | 'autoscaling_required'
  | 'insufficient';

export class ResourceAmountDto {
  @ApiProperty({ example: '800m' })
  cpu: string;

  @ApiProperty({ example: '896Mi' })
  memory: string;
}

export class BuildResourcesResponseDto {
  /**
   * Synthetic status the frontend uses to decide which UI state to render:
   *   - ok                  → enough resources, proceed
   *   - autoscaling_required → not enough now, autoscaling is on; `message` says
   *                             whether a node will actually appear
   *   - insufficient        → not enough, autoscaling disabled — user must act
   */
  @ApiProperty({
    enum: ['ok', 'autoscaling_required', 'insufficient'],
    example: 'ok',
  })
  status: BuildResourceStatus;

  @ApiProperty({
    type: ResourceAmountDto,
    description: 'Fixed resources required by the build job',
  })
  required: ResourceAmountDto;

  @ApiProperty({
    type: ResourceAmountDto,
    description: 'Resources currently available (after 10% safety margin)',
  })
  available: ResourceAmountDto;

  @ApiProperty({
    type: ResourceAmountDto,
    description: 'Total allocatable resources across all ready nodes',
  })
  total: ResourceAmountDto;

  @ApiProperty({
    type: ResourceAmountDto,
    description: 'Resources already requested by running pods',
  })
  used: ResourceAmountDto;

  @ApiProperty({
    example: false,
    description: 'Whether the cluster has autoscaling enabled',
  })
  autoscalingEnabled: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Plain sentence for the status above, including whether a node will ' +
      'actually appear. null when the build job fits.',
  })
  message: string | null;
}
