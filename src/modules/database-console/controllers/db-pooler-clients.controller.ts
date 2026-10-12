import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppAccessGuard } from '../../applications/guards/app-access.guard';
import { PlatformFoundationGuard } from '../guards/platform-foundation.guard';
import { DataDoor } from '../../iam/decorators/data-door.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import {
  DbPoolerClientCloseDto,
  DbPoolerClientCloseResultDto,
} from '../dto/db-sessions.dto';
import { DbSessionsService } from '../services/db-sessions.service';

/** A pooled connection of a managed PostgreSQL, closed from the pooler's side. */
@ApiTags('Database Console')
@UseGuards(PlatformFoundationGuard, AppAccessGuard)
@DataDoor()
@Controller('applications/:id/db/pooler/clients')
export class DbPoolerClientsController {
  constructor(private readonly sessions: DbSessionsService) {}

  @Post(':clientId/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ActionCycle({
    action: 'POST /applications/:id/db/pooler/clients/:clientId/close',
    bind: ['id', 'clientId'],
    sentence: 'close pooled connection {clientId} of database {id}',
    consequence:
      'The connection is closed and its open transaction, if any, is rolled back. The application has to reconnect.',
  })
  @ApiOperation({
    summary: 'Close a connection held by the pooler',
    description:
      'Send pod and connectTime exactly as the session list returned them: a client that has ended since, or whose id now names another client, answers 409.',
  })
  @ApiOkResponse({ type: DbPoolerClientCloseResultDto })
  close(
    @Param('id') id: string,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Body() dto: DbPoolerClientCloseDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<DbPoolerClientCloseResultDto> {
    return this.sessions.closePoolerClient(
      id,
      { pod: dto.pod, clientId, connectTime: dto.connectTime },
      req.user?.userId,
    );
  }
}
