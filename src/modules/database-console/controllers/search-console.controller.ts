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
import { PlatformFoundationGuard } from '../guards/platform-foundation.guard';
import { SearchQueryService } from '../services/search-query.service';
import {
  SearchAssistService,
  SearchAssistResult,
  SearchRawAssistResult,
} from '../services/search-assist.service';
import {
  SearchAssistDto,
  SearchCountDto,
  SearchIndexRefDto,
  SearchQueryDto,
  SearchRawDto,
} from '../dto/search-console.dto';
import {
  SearchClusterInfo,
  SearchIndex,
  SearchResponse,
} from '../engine/search-engine';
import { RawRestResponse } from '../engine/raw-rest';
import { SearchConnectionInfo } from '../interfaces/search-connection';

const DEFAULT_SIZE = 20;

/** Read-only search console (OpenSearch / ES-wire): browse indices + run query DSL. */
@UseGuards(PlatformFoundationGuard, AppOwnershipGuard)
@Controller('applications/:id/search')
export class SearchConsoleController {
  constructor(
    private readonly search: SearchQueryService,
    private readonly assistService: SearchAssistService,
  ) {}

  @Post('assist')
  assist(
    @Param('id') id: string,
    @Body() dto: SearchAssistDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<SearchAssistResult> {
    return this.assistService.assist(
      { appId: id, fluiUserId: req.user.userId },
      dto.prompt,
      dto.conversation,
      {
        model: dto.model,
        provider: dto.provider,
        connectionId: dto.connectionId,
      },
      { index: dto.index },
    );
  }

  /** Dev Tools copilot: NL → one raw REST request the console editor receives. */
  @Post('assist-raw')
  assistRaw(
    @Param('id') id: string,
    @Body() dto: SearchAssistDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<SearchRawAssistResult> {
    return this.assistService.assistRaw(
      { appId: id, fluiUserId: req.user.userId },
      dto.prompt,
      dto.conversation,
      {
        model: dto.model,
        provider: dto.provider,
        connectionId: dto.connectionId,
      },
      { index: dto.index },
    );
  }

  @Get('connection-info')
  connectionInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<SearchConnectionInfo> {
    return this.search.connectionInfo({
      appId: id,
      fluiUserId: req.user.userId,
    });
  }

  @Get('cluster-info')
  clusterInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<SearchClusterInfo> {
    return this.search.clusterInfo({ appId: id, fluiUserId: req.user.userId });
  }

  @Get('indices')
  indices(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<SearchIndex[]> {
    return this.search.listIndices({ appId: id, fluiUserId: req.user.userId });
  }

  @Post('mapping')
  mapping(
    @Param('id') id: string,
    @Body() dto: SearchIndexRefDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<Record<string, unknown>> {
    return this.search.getMapping(
      { appId: id, fluiUserId: req.user.userId },
      dto.index,
    );
  }

  @Post('query')
  query(
    @Param('id') id: string,
    @Body() dto: SearchQueryDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<SearchResponse> {
    return this.search.search(
      { appId: id, fluiUserId: req.user.userId },
      dto.index,
      dto.body ?? { query: { match_all: {} } },
      { from: dto.from ?? 0, size: dto.size ?? DEFAULT_SIZE },
    );
  }

  @Post('count')
  count(
    @Param('id') id: string,
    @Body() dto: SearchCountDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ count: number }> {
    return this.search
      .count({ appId: id, fluiUserId: req.user.userId }, dto.index, dto.body)
      .then((count) => ({ count }));
  }

  /** Dev Tools console: run one raw REST call. Read-only gate on unless opted out. */
  @Post('raw')
  raw(
    @Param('id') id: string,
    @Body() dto: SearchRawDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<RawRestResponse> {
    return this.search.runRaw(
      { appId: id, fluiUserId: req.user.userId },
      { method: dto.method, path: dto.path, body: dto.body },
      { readOnly: dto.readOnly !== false },
    );
  }
}
