import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ByosNodeSshTargetDto {
  @ApiPropertyOptional({
    description:
      'SSH host for this node (the operator-reachable address). Omit to use the node IP.',
  })
  @IsOptional()
  @IsString()
  host?: string;

  @ApiPropertyOptional({ example: 22, default: 22 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional({ example: 'root', default: 'root' })
  @IsOptional()
  @IsString()
  user?: string;
}

export class RegisterByosNodeDto {
  @ApiProperty({
    example: 'control-cluster-worker-1',
    description:
      'k3s node / server name — the idempotency key within a cluster',
  })
  @IsString()
  serverName: string;

  @ApiPropertyOptional({ enum: ['worker', 'master'], default: 'worker' })
  @IsOptional()
  @IsIn(['worker', 'master'])
  nodeType?: 'worker' | 'master';

  @ApiPropertyOptional({
    description: 'Operator-reachable address (SSH host / published endpoint)',
  })
  @IsOptional()
  @IsString()
  ipAddress?: string;

  @ApiPropertyOptional({
    description:
      "The node's real on-network private IP. Feeds the host firewall's " +
      'internalCidrs so nodes accept each other’s k3s traffic.',
  })
  @IsOptional()
  @IsString()
  privateIp?: string;

  @ApiPropertyOptional({ type: ByosNodeSshTargetDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ByosNodeSshTargetDto)
  byos?: ByosNodeSshTargetDto;
}
