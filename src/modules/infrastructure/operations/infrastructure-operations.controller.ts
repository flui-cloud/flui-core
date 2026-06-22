import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { InfrastructureOperationsService } from './infrastructure-operations.service';
import { InfrastructureOperationEntity } from '../servers/entities/infrastructure-operations.entity';
import { RequireSection } from '../../iam/decorators/require-section.decorator';

@ApiTags('Infrastructure - Operations')
@ApiBearerAuth()
@Controller('infrastructure/operations')
@RequireSection('infrastructure')
export class InfrastructureOperationsController {
  constructor(
    private readonly operationsService: InfrastructureOperationsService,
  ) {}

  @Get(':operationId')
  @ApiOperation({
    summary: 'Get infrastructure operation status',
    description:
      'Returns status and progress of any infrastructure operation (servers, clusters, etc.)',
  })
  @ApiParam({
    name: 'operationId',
    description: 'Operation ID returned from create/delete operations',
    example: 'uuid-operation-id',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns operation details',
    type: InfrastructureOperationEntity,
  })
  @ApiResponse({ status: 404, description: 'Operation not found' })
  async getOperationStatus(
    @Param('operationId') operationId: string,
  ): Promise<InfrastructureOperationEntity> {
    return await this.operationsService.getOperationDetails(operationId);
  }
}
