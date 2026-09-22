import { MAX_FLEET_NODES, MIN_FLEET_NODES } from '../../scaling/scaling.core';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateClusterAutoscaleDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  /**
   * @deprecated Accepted and ignored. Nothing about growth depends on it: a
   * cluster grows when a scaling group on it is set to buy. Removed with the
   * column it used to write.
   */
  autoscalingEnabled?: boolean;

  @ApiPropertyOptional({ example: 2, minimum: 1, maximum: MAX_FLEET_NODES })
  @IsOptional()
  @IsInt()
  @Min(MIN_FLEET_NODES)
  @Max(MAX_FLEET_NODES)
  minNodes?: number;

  @ApiPropertyOptional({ example: 5, minimum: 1, maximum: MAX_FLEET_NODES })
  @IsOptional()
  @IsInt()
  @Min(MIN_FLEET_NODES)
  @Max(MAX_FLEET_NODES)
  maxNodes?: number;
}
