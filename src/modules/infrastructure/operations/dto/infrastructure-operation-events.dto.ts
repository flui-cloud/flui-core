import { ApiProperty } from '@nestjs/swagger';
import { OperationType } from '../../servers/entities/infrastructure-operations.entity';

export class InfrastructureOperationProgressDto {
  @ApiProperty({ example: 'op-uuid' })
  operationId: string;

  @ApiProperty({ example: 'resource-uuid' })
  resourceId: string;

  @ApiProperty({ enum: OperationType })
  operationType: OperationType;

  @ApiProperty({ example: 'server' })
  resourceType: string;

  @ApiProperty({ example: 42 })
  percentage: number;

  @ApiProperty({ example: 2 })
  currentStepIndex: number;

  @ApiProperty({ example: 4 })
  totalSteps: number;

  @ApiProperty({ example: 'Deleting server from cloud provider...' })
  message: string;

  @ApiProperty()
  timestamp: Date;
}

export class InfrastructureOperationCompletedDto {
  @ApiProperty({ example: 'op-uuid' })
  operationId: string;

  @ApiProperty({ example: 'resource-uuid' })
  resourceId: string;

  @ApiProperty({ enum: OperationType })
  operationType: OperationType;

  @ApiProperty({ example: 'server' })
  resourceType: string;

  @ApiProperty({ example: 12340 })
  duration: number;

  @ApiProperty()
  timestamp: Date;
}

export class InfrastructureOperationLogDto {
  @ApiProperty({ example: 'op-uuid' })
  operationId: string;

  @ApiProperty({ example: 'resource-uuid' })
  resourceId: string;

  @ApiProperty({ example: '[2026-09-12T10:00:00Z] Installing K3s...\n' })
  chunk: string;

  @ApiProperty()
  timestamp: Date;
}

export class InfrastructureOperationFailedDto {
  @ApiProperty({ example: 'op-uuid' })
  operationId: string;

  @ApiProperty({ example: 'resource-uuid' })
  resourceId: string;

  @ApiProperty({ enum: OperationType })
  operationType: OperationType;

  @ApiProperty({ example: 'server' })
  resourceType: string;

  @ApiProperty({ example: 'Provider returned 500: internal error' })
  error: string;

  @ApiProperty()
  timestamp: Date;
}
