import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AutoscaleActuation } from '../services/autoscale-actuation';

export type ResourceAvailabilityReason =
  | 'insufficient_resources'
  | 'autoscaling_pending'
  | null;

export class ResourceAmountStringDto {
  @ApiProperty({
    example: '250m',
    description: 'CPU in millicores (e.g. "250m", "1000m")',
  })
  cpu: string;

  @ApiProperty({
    example: '256Mi',
    description: 'Memory in Mi (e.g. "256Mi", "1Gi")',
  })
  memory: string;
}

export class ResourceAvailabilityResponseDto {
  @ApiProperty({
    example: true,
    description: 'Whether the cluster can accommodate the requested resources',
  })
  canDeploy: boolean;

  @ApiPropertyOptional({
    example: 'insufficient_resources',
    enum: ['insufficient_resources', 'autoscaling_pending'],
    nullable: true,
    description:
      'Machine-readable reason when resources are not freely available. ' +
      'null = ok; "insufficient_resources" = not enough capacity, autoscaling OFF; ' +
      '"autoscaling_pending" = not enough capacity now but autoscaling will handle it.',
  })
  reason: ResourceAvailabilityReason;

  @ApiPropertyOptional({
    example: 'medium',
    description:
      'The profile that was checked (null for custom resource requests)',
    nullable: true,
  })
  profile: string | null;

  @ApiProperty({
    type: ResourceAmountStringDto,
    description: 'Resources required by the request',
  })
  required: ResourceAmountStringDto;

  @ApiProperty({
    type: ResourceAmountStringDto,
    description: 'Resources available after 10% margin',
  })
  available: ResourceAmountStringDto;

  @ApiProperty({
    type: ResourceAmountStringDto,
    description: 'Total allocatable resources in the cluster',
  })
  total: ResourceAmountStringDto;

  @ApiProperty({
    type: ResourceAmountStringDto,
    description: 'Resources currently in use by running pods',
  })
  used: ResourceAmountStringDto;

  @ApiProperty({ example: false })
  autoscalingEnabled: boolean;

  @ApiProperty({
    enum: AutoscaleActuation,
    description:
      'What happens on this provider when the cluster runs out of room. ' +
      'Derived from provider capability and from whether anything is registered ' +
      'to add nodes on its own.',
  })
  actuation: AutoscaleActuation;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Plain sentence for the reason above, including whether a node will ' +
      'actually appear. null when the request fits.',
  })
  reasonMessage: string | null;
}
