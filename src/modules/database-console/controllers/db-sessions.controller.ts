import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppAccessGuard } from '../../applications/guards/app-access.guard';
import { PlatformFoundationGuard } from '../guards/platform-foundation.guard';
import { DataDoor } from '../../iam/decorators/data-door.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import {
  DbSessionActionDto,
  DbSessionActionResultDto,
  DbSessionsResponseDto,
} from '../dto/db-sessions.dto';
import { DbSessionsService } from '../services/db-sessions.service';

type SessionsRequest = { user: AuthenticatedUser };

/**
 * Active sessions of a managed PostgreSQL. Reading them is reading the
 * database's activity — who is connected and the shape of what they run — so
 * it is a data door; stopping one is a write on the application.
 */
@ApiTags('Database Console')
@UseGuards(PlatformFoundationGuard, AppAccessGuard)
@DataDoor()
@Controller('applications/:id/db/sessions')
export class DbSessionsController {
  constructor(private readonly sessions: DbSessionsService) {}

  @Get()
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Sessions connected to a managed PostgreSQL',
    description:
      'Who is connected, what each session is doing (statement with literals masked), how long, what it waits for and which sessions block which. Idle sessions are left out unless all=true.',
  })
  @ApiQuery({ name: 'all', required: false, type: Boolean })
  @ApiOkResponse({ type: DbSessionsResponseDto })
  list(
    @Param('id') id: string,
    @Query('all') all?: string,
  ): Promise<DbSessionsResponseDto> {
    return this.sessions.list(id, { includeIdle: all === 'true' });
  }

  @Post(':pid/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ActionCycle({
    action: 'POST /applications/:id/db/sessions/:pid/cancel',
    bind: ['id', 'pid'],
    sentence: 'cancel the query running in session {pid} of database {id}',
    consequence:
      'The statement stops with an error in the application that sent it. The connection stays open.',
  })
  @ApiOperation({
    summary: 'Cancel the statement a session is running',
    description:
      'Send backendStart exactly as the session list returned it: a session that has ended since, or whose pid now belongs to another session, answers 409.',
  })
  @ApiOkResponse({ type: DbSessionActionResultDto })
  cancel(
    @Param('id') id: string,
    @Param('pid', ParseIntPipe) pid: number,
    @Body() dto: DbSessionActionDto,
    @Request() req: SessionsRequest,
  ): Promise<DbSessionActionResultDto> {
    return this.sessions.act(
      id,
      pid,
      dto.backendStart,
      'cancel',
      req.user?.userId,
    );
  }

  @Post(':pid/terminate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ActionCycle({
    action: 'POST /applications/:id/db/sessions/:pid/terminate',
    bind: ['id', 'pid'],
    sentence: 'close session {pid} of database {id}',
    consequence:
      'The connection is closed and its open transaction, if any, is rolled back. The application has to reconnect.',
  })
  @ApiOperation({
    summary: 'Close a session',
    description:
      'Send backendStart exactly as the session list returned it: a session that has ended since, or whose pid now belongs to another session, answers 409.',
  })
  @ApiOkResponse({ type: DbSessionActionResultDto })
  terminate(
    @Param('id') id: string,
    @Param('pid', ParseIntPipe) pid: number,
    @Body() dto: DbSessionActionDto,
    @Request() req: SessionsRequest,
  ): Promise<DbSessionActionResultDto> {
    return this.sessions.act(
      id,
      pid,
      dto.backendStart,
      'terminate',
      req.user?.userId,
    );
  }
}
