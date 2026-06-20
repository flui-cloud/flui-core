import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppOwnershipGuard } from '../guards/app-ownership.guard';
import {
  KvScanDto,
  KvReadKeyDto,
  KvCommandDto,
  KvAssistDto,
} from '../dto/kv-console.dto';
import { KvQueryService } from '../services/kv-query.service';
import { KvAssistResult, KvAssistService } from '../services/kv-assist.service';
import {
  CommandResult,
  KeyValueRead,
  KeyspaceSummary,
  ScanResult,
} from '../engine/keyvalue-engine';

const DEFAULT_SCAN_COUNT = 100;

/** Key-value (Redis/Valkey) console surface: keyspace browse + a read-only-gated command. */
@UseGuards(AppOwnershipGuard)
@Controller('applications/:id/kv')
export class KvConsoleController {
  constructor(
    private readonly kv: KvQueryService,
    private readonly assistService: KvAssistService,
  ) {}

  // Data-blind keyspace overview (counts only).
  @Get('summary')
  async summary(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<KeyspaceSummary> {
    return this.kv.summary({ dbInstallId: id, fluiUserId: req.user.userId });
  }

  @Post('keys')
  async keys(
    @Param('id') id: string,
    @Body() dto: KvScanDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<ScanResult> {
    return this.kv.scan(
      { dbInstallId: id, fluiUserId: req.user.userId },
      {
        cursor: dto.cursor,
        match: dto.match,
        count: dto.count ?? DEFAULT_SCAN_COUNT,
      },
    );
  }

  @Post('value')
  async value(
    @Param('id') id: string,
    @Body() dto: KvReadKeyDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<KeyValueRead> {
    return this.kv.readKey(
      { dbInstallId: id, fluiUserId: req.user.userId },
      dto.key,
    );
  }

  @Post('command')
  async command(
    @Param('id') id: string,
    @Body() dto: KvCommandDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<CommandResult> {
    return this.kv.runCommand(
      { dbInstallId: id, fluiUserId: req.user.userId },
      dto.args,
      dto.readOnly ?? true,
    );
  }

  // Data-blind NL→command: receives the keyspace summary (counts only) + KB, never key names/values.
  @Post('assist')
  async assist(
    @Param('id') id: string,
    @Body() dto: KvAssistDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<KvAssistResult> {
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
