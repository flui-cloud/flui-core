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
  FulltextIndex,
  FulltextSearchResult,
  FulltextServerInfo,
} from '../engine/fulltext-engine';
import { RawRestResponse } from '../engine/raw-rest';
import { FulltextConnectionInfo } from '../interfaces/fulltext-connection';
import { FulltextQueryService } from '../services/fulltext-query.service';
import {
  FulltextAssistService,
  FulltextRawSuggestion,
  FulltextSearchSuggestion,
} from '../services/fulltext-assist.service';
import {
  FulltextAssistDto,
  FulltextRawDto,
  FulltextSearchDto,
} from '../dto/fulltext-console.dto';

/**
 * Full-text (Meilisearch) console: index list + search browse, a raw REST Dev
 * Tools passthrough (writes gated by the read-only flag), and an NL copilot.
 */
@UseGuards(AppOwnershipGuard)
@Controller('applications/:id/fulltext')
export class FulltextConsoleController {
  constructor(
    private readonly fulltext: FulltextQueryService,
    private readonly assistant: FulltextAssistService,
  ) {}

  @Get('connection-info')
  connectionInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<FulltextConnectionInfo> {
    return this.fulltext.connectionInfo({
      appId: id,
      fluiUserId: req.user.userId,
    });
  }

  @Get('server-info')
  serverInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<FulltextServerInfo> {
    return this.fulltext.serverInfo({ appId: id, fluiUserId: req.user.userId });
  }

  @Get('indexes')
  indexes(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<FulltextIndex[]> {
    return this.fulltext.listIndexes({
      appId: id,
      fluiUserId: req.user.userId,
    });
  }

  @Post('search')
  search(
    @Param('id') id: string,
    @Body() dto: FulltextSearchDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<FulltextSearchResult> {
    return this.fulltext.search(
      { appId: id, fluiUserId: req.user.userId },
      dto.index,
      { q: dto.q, filter: dto.filter, limit: dto.limit, offset: dto.offset },
    );
  }

  @Post('raw')
  raw(
    @Param('id') id: string,
    @Body() dto: FulltextRawDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<RawRestResponse> {
    return this.fulltext.runRaw(
      { appId: id, fluiUserId: req.user.userId },
      { method: dto.method, path: dto.path, body: dto.body },
      { readOnly: dto.readOnly !== false },
    );
  }

  @Post('assist')
  assist(
    @Param('id') id: string,
    @Body() dto: FulltextAssistDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<FulltextSearchSuggestion> {
    return this.assistant.assistSearch(
      { appId: id, fluiUserId: req.user.userId },
      dto.prompt,
      dto.index,
      dto.conversation ?? [],
      {
        model: dto.model,
        provider: dto.provider,
        connectionId: dto.connectionId,
      },
    );
  }

  @Post('assist-raw')
  assistRaw(
    @Param('id') id: string,
    @Body() dto: FulltextAssistDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<FulltextRawSuggestion> {
    return this.assistant.assistRaw(
      { appId: id, fluiUserId: req.user.userId },
      dto.prompt,
      dto.conversation ?? [],
      {
        model: dto.model,
        provider: dto.provider,
        connectionId: dto.connectionId,
      },
    );
  }
}
