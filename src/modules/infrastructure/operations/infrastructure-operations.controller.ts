import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
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
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { mayReadOperation } from './helpers/operation-ownership.helper';

@ApiTags('Infrastructure - Operations')
@ApiBearerAuth()
@Controller('infrastructure/operations')
@RequireSection('infrastructure')
export class InfrastructureOperationsController {
  constructor(
    private readonly operationsService: InfrastructureOperationsService,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  @Get(':operationId')
  // `app:read` and not `cluster:read`: the handler already answers 404 for an
  // operation that is not the caller's, a sandbox guest is shown its own
  // operations for real, and a guest holds no cluster permission at all. It is
  // here so the credential ceiling can see the route, which it does only
  // through `@RequirePermission` and `@AppAction`.
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Get infrastructure operation status',
    description:
      'Returns status and progress of an infrastructure operation you started ' +
      '(servers, clusters, deploys). Operators who hold the infrastructure ' +
      'section at its full level see every operation on the instance.',
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
    @Req() req: Request,
  ): Promise<InfrastructureOperationEntity> {
    const operation =
      await this.operationsService.getOperationDetails(operationId);
    const user = req.user as AuthenticatedUser | undefined;
    if (await this.mayRead(operation, user)) return operation;
    // The same 404 a missing id gets: an operation that is not yours must not
    // be distinguishable from one that does not exist.
    throw new NotFoundException(`Operation ${operationId} not found`);
  }

  @Post(':operationId/cancel')
  // The same permission and the same ownership rule as reading it: whoever may
  // watch an operation may ask it to stop. It is not a destructive verb — it
  // asks the work to end between two consistent steps rather than removing
  // anything.
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Ask a running operation to stop',
    description:
      'Records the request; the operation ends at its next step boundary and ' +
      'never mid-step, because a provisioning cut in half leaves paid-for ' +
      'resources orphaned. Already-finished operations are left alone.',
  })
  @ApiParam({ name: 'operationId', description: 'Operation ID' })
  @ApiResponse({ status: 201, description: 'Cancellation requested' })
  @ApiResponse({ status: 404, description: 'Operation not found' })
  async cancelOperation(
    @Param('operationId') operationId: string,
    @Req() req: Request,
  ) {
    const operation =
      await this.operationsService.getOperationDetails(operationId);
    const user = req.user as AuthenticatedUser | undefined;
    if (!(await this.mayRead(operation, user))) {
      throw new NotFoundException(`Operation ${operationId} not found`);
    }
    return this.operationsService.requestCancellation(operationId);
  }

  /** The rule itself lives next to the WebSocket door that asks it too. */
  private mayRead(
    operation: InfrastructureOperationEntity,
    user: AuthenticatedUser | undefined,
  ): Promise<boolean> {
    return mayReadOperation(this.policy, operation, user);
  }
}
