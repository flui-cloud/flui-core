import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  AppOwnershipGuard,
  CONSOLE_READER,
} from '../guards/app-ownership.guard';
import { PlatformFoundationGuard } from '../guards/platform-foundation.guard';
import { RunQueryDto } from '../dto/run-query.dto';
import { DbAssistDto } from '../dto/db-assist.dto';
import {
  DbQueryService,
  READER_STATEMENT_TIMEOUT_MS,
} from '../services/db-query.service';
import { DbAssistResult, DbAssistService } from '../services/db-assist.service';
import { DbConnectionInfoResponseDto } from '../dto/db-connection-info-response.dto';
import { SchemaTree, SqlQueryResult } from '../engine/sql-engine';
import { DataDoor } from '../../iam/decorators/data-door.decorator';
import { OpenOnShowcase } from '../../iam/decorators/open-on-showcase.decorator';
import { DbConnectionResolveInput } from '../interfaces/db-connection';

type ConsoleRequest = {
  user: AuthenticatedUser;
  [CONSOLE_READER]?: boolean;
};

const inputOf = (
  id: string,
  req: ConsoleRequest,
): DbConnectionResolveInput => ({
  dbInstallId: id,
  fluiUserId: req.user.userId,
  access: req[CONSOLE_READER] ? 'reader' : 'owner',
});

const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ROWS = 1000;

@UseGuards(PlatformFoundationGuard, AppOwnershipGuard)
@DataDoor()
@Controller('applications/:id/db')
export class DbConsoleController {
  constructor(
    private readonly queryService: DbQueryService,
    private readonly assistService: DbAssistService,
  ) {}

  // A reader's session is read-only whatever the request says, and shorter.
  @Post('query')
  @OpenOnShowcase()
  async query(
    @Param('id') id: string,
    @Body() dto: RunQueryDto,
    @Request() req: ConsoleRequest,
  ): Promise<SqlQueryResult> {
    const reader = !!req[CONSOLE_READER];
    return this.queryService.runQuery(inputOf(id, req), dto.sql, {
      readOnly: reader || (dto.readOnly ?? true),
      statementTimeoutMs: reader
        ? READER_STATEMENT_TIMEOUT_MS
        : DEFAULT_STATEMENT_TIMEOUT_MS,
      maxRows: reader
        ? Math.min(dto.limit ?? DEFAULT_MAX_ROWS, DEFAULT_MAX_ROWS)
        : (dto.limit ?? DEFAULT_MAX_ROWS),
    });
  }

  // Non-secret coordinates for reaching the DB (host/port/db/user). The password is
  // never returned here — it's fetched from the cluster Secret via the CLI.
  @Get('connection-info')
  @ApiOkResponse({ type: DbConnectionInfoResponseDto })
  async connectionInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<DbConnectionInfoResponseDto> {
    const info = await this.queryService.connectionInfo({
      dbInstallId: id,
      fluiUserId: req.user.userId,
    });
    return new DbConnectionInfoResponseDto(info);
  }

  @Get('schema')
  @OpenOnShowcase()
  async schema(
    @Param('id') id: string,
    @Request() req: ConsoleRequest,
  ): Promise<SchemaTree> {
    return this.queryService.introspect(inputOf(id, req));
  }

  // Data-blind NL→SQL: receives schema + question + KB, never the result rows.
  @Post('assist')
  @OpenOnShowcase()
  async assist(
    @Param('id') id: string,
    @Body() dto: DbAssistDto,
    @Request() req: ConsoleRequest,
  ): Promise<DbAssistResult> {
    return this.assistService.assist(
      inputOf(id, req),
      dto.prompt,
      dto.conversation,
      {
        model: dto.model,
        provider: dto.provider,
        connectionId: dto.connectionId,
      },
    );
  }
}
