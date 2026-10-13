import {
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../iam/constants/iam-permissions';
import { SandboxTestVisitorDto } from './dto/sandbox-visitor-test.dto';
import {
  SandboxVisitorTestService,
  VISITOR_TEST_ROUTE_ENV,
  visitorTestRouteEnabled,
} from './services/sandbox-visitor-test.service';

@ApiTags('Sandbox')
@Controller('sandbox/visitors')
export class SandboxVisitorTestController {
  constructor(private readonly visitors: SandboxVisitorTestService) {}

  @Post('test')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(IAM_PERMISSION.IAM_MANAGE_USERS)
  @ApiOperation({
    summary: 'TEST ONLY: create a demo visitor and a key that acts as it',
    description: `Test route for checking a visitor's limits on a live instance. Answers 404 unless ${VISITOR_TEST_ROUTE_ENV}=true. Creates the identity-provider account, the local visitor with its read-only grants, and a reading API key returned once.`,
  })
  @ApiResponse({ status: 201, type: SandboxTestVisitorDto })
  @ApiResponse({ status: 404, description: 'The test route is switched off' })
  async create(): Promise<SandboxTestVisitorDto> {
    if (!visitorTestRouteEnabled()) {
      throw new NotFoundException('Cannot POST /sandbox/visitors/test');
    }
    return this.visitors.create();
  }
}
