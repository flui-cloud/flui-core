import { Body, Controller, Get, Param, Post, Request } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { RunQueryDto } from '../dto/run-query.dto';
import { DbAssistDto } from '../dto/db-assist.dto';
import { DbQueryService } from '../services/db-query.service';
import { DbAssistResult, DbAssistService } from '../services/db-assist.service';
import { DbConnectionInfo } from '../interfaces/db-connection';
import { SchemaTree, SqlQueryResult } from '../engine/sql-engine';

const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ROWS = 1000;

@Controller('applications/:id/db')
export class DbConsoleController {
  constructor(
    private readonly queryService: DbQueryService,
    private readonly assistService: DbAssistService,
  ) {}

  @Post('query')
  async query(
    @Param('id') id: string,
    @Body() dto: RunQueryDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<SqlQueryResult> {
    return this.queryService.runQuery(
      { dbInstallId: id, fluiUserId: req.user.userId },
      dto.sql,
      {
        readOnly: dto.readOnly ?? true,
        statementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
        maxRows: dto.limit ?? DEFAULT_MAX_ROWS,
      },
    );
  }

  // Non-secret coordinates for reaching the DB (host/port/db/user). The password is
  // never returned here — it's fetched from the cluster Secret via the CLI.
  @Get('connection-info')
  async connectionInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<DbConnectionInfo> {
    return this.queryService.connectionInfo({
      dbInstallId: id,
      fluiUserId: req.user.userId,
    });
  }

  @Get('schema')
  async schema(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<SchemaTree> {
    return this.queryService.introspect({
      dbInstallId: id,
      fluiUserId: req.user.userId,
    });
  }

  // Data-blind NL→SQL: receives schema + question + KB, never the result rows.
  @Post('assist')
  async assist(
    @Param('id') id: string,
    @Body() dto: DbAssistDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<DbAssistResult> {
    return this.assistService.assist(
      { dbInstallId: id, fluiUserId: req.user.userId },
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
