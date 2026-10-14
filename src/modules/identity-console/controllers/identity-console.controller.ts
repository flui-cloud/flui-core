import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { actorFromRequest } from '../../auth/utils/actor.util';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  IdentityConsoleActor,
  IdentityConsoleService,
} from '../services/identity-console.service';
import {
  IdentityConsoleStatusDto,
  OpenIdentityConsoleDto,
} from '../dto/identity-console.dto';

type ConsoleRequest = Parameters<typeof actorFromRequest>[0] & {
  user?: AuthenticatedUser;
};

function actorOf(req: ConsoleRequest): IdentityConsoleActor {
  const actor = actorFromRequest(req);
  return {
    userId: req.user?.userId ?? null,
    email: req.user?.email ?? null,
    kind: actor.kind,
    keyId: actor.keyId ?? null,
  };
}

@ApiTags('Identity')
@ApiBearerAuth()
@Controller('identity/console')
export class IdentityConsoleController {
  constructor(private readonly console: IdentityConsoleService) {}

  @Get()
  @RequirePermission(IAM_PERMISSION.IAM_READ_ACCESS)
  @ApiOperation({
    summary: "Whether the identity provider's console is reachable",
    description:
      'Closed by default: the console path redirects to the dashboard (403 when no dashboard address is known) while sign-in keeps working. ' +
      'When open, says until when, who opened it and why.',
  })
  @ApiResponse({ status: 200, type: IdentityConsoleStatusDto })
  status(): Promise<IdentityConsoleStatusDto> {
    return this.console.status();
  }

  @Post('open')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(IAM_PERMISSION.IAM_MANAGE_USERS)
  @ApiOperation({
    summary: "Open the identity provider's console for a while",
    description:
      'Reachable for `minutes` (default 60, at most 240), then it closes by itself. Recorded in the audit log ' +
      'with who and why. Refused to agents.',
  })
  @ApiResponse({ status: 200, type: IdentityConsoleStatusDto })
  open(
    @Body() dto: OpenIdentityConsoleDto,
    @Request() req: ConsoleRequest,
  ): Promise<IdentityConsoleStatusDto> {
    return this.console.open(actorOf(req), dto.minutes, dto.reason);
  }

  @Post('close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(IAM_PERMISSION.IAM_MANAGE_USERS)
  @ApiOperation({
    summary: "Close the identity provider's console now",
    description: 'Idempotent. Recorded in the audit log.',
  })
  @ApiResponse({ status: 200, type: IdentityConsoleStatusDto })
  close(@Request() req: ConsoleRequest): Promise<IdentityConsoleStatusDto> {
    return this.console.close(actorOf(req));
  }
}
