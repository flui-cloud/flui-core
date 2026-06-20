import {
  BadRequestException,
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
  DocAssistDto,
  DocCollectionsDto,
  DocCommandDto,
  DocFieldsDto,
  DocFindDto,
  DocShellDto,
} from '../dto/document-console.dto';
import { DocumentQueryService } from '../services/document-query.service';
import {
  DocAssistResult,
  DocumentAssistService,
} from '../services/document-assist.service';
import {
  CommandResult,
  DocumentCollection,
  DocumentDatabase,
  DocumentField,
  DocumentFindOptions,
  DocumentPage,
  DocumentStoreSummary,
  ShellResult,
} from '../engine/document-engine';
import { DbConnectionInfo } from '../interfaces/db-connection';

const DEFAULT_FIND_LIMIT = 100;
const DEFAULT_SKIP = 0;

/** Parse a mongosh-syntax object literal (e.g. filter/sort/projection) into a plain JS object. */
function parseShellQuery(
  text: string | undefined,
): Record<string, unknown> | undefined {
  if (!text?.trim()) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parse } = require('@mongodb-js/shell-bson-parser') as {
      parse: (input: string, opts: { mode: string }) => Record<string, unknown>;
    };
    return parse(text, { mode: 'loose' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BadRequestException(`Invalid query syntax: ${msg}`);
  }
}

/** Document (FerretDB / Mongo-wire) console: browse + read-only-gated command. */
@UseGuards(AppOwnershipGuard)
@Controller('applications/:id/doc')
export class DocumentConsoleController {
  constructor(
    private readonly docs: DocumentQueryService,
    private readonly assistService: DocumentAssistService,
  ) {}

  @Get('summary')
  async summary(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<DocumentStoreSummary> {
    return this.docs.summary({ dbInstallId: id, fluiUserId: req.user.userId });
  }

  @Get('databases')
  async databases(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<DocumentDatabase[]> {
    return this.docs.databases({
      dbInstallId: id,
      fluiUserId: req.user.userId,
    });
  }

  @Post('collections')
  async collections(
    @Param('id') id: string,
    @Body() dto: DocCollectionsDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<DocumentCollection[]> {
    return this.docs.collections(
      { dbInstallId: id, fluiUserId: req.user.userId },
      dto.database,
    );
  }

  @Post('documents')
  async documents(
    @Param('id') id: string,
    @Body() dto: DocFindDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<DocumentPage> {
    // *Text fields carry raw mongosh syntax from the Compass-style query bar.
    // They take precedence over the structured counterparts so the UI never needs
    // to pre-parse (and never risks sending BSON types over JSON).
    const opts: DocumentFindOptions = {
      filter: parseShellQuery(dto.filterText) ?? dto.filter,
      sort: (parseShellQuery(dto.sortText) ?? dto.sort) as
        | Record<string, 1 | -1>
        | undefined,
      projection: (parseShellQuery(dto.projectionText) ?? dto.projection) as
        | Record<string, 0 | 1>
        | undefined,
      limit: dto.limit ?? DEFAULT_FIND_LIMIT,
      skip: dto.skip ?? DEFAULT_SKIP,
    };
    return this.docs.find(
      { dbInstallId: id, fluiUserId: req.user.userId },
      dto.database,
      dto.collection,
      opts,
    );
  }

  // Inferred field structure (dotted paths + types) for query-bar autocomplete.
  @Post('fields')
  async fields(
    @Param('id') id: string,
    @Body() dto: DocFieldsDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<DocumentField[]> {
    return this.docs.fields(
      { dbInstallId: id, fluiUserId: req.user.userId },
      dto.database,
      dto.collection,
    );
  }

  @Post('command')
  async command(
    @Param('id') id: string,
    @Body() dto: DocCommandDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<CommandResult> {
    return this.docs.runCommand(
      { dbInstallId: id, fluiUserId: req.user.userId },
      dto.database,
      dto.command,
      dto.readOnly ?? true,
    );
  }

  // mongosh-syntax shell: translate one statement to a Mongo command and run it
  // through the read-only-gated command path (no JS eval anywhere).
  @Post('shell')
  async shell(
    @Param('id') id: string,
    @Body() dto: DocShellDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<ShellResult> {
    return this.docs.runShell(
      { dbInstallId: id, fluiUserId: req.user.userId },
      dto.database,
      dto.input,
      dto.readOnly ?? true,
    );
  }

  // Data-blind NL→mongosh: receives structure (collection names + inferred field
  // types) + the question + KB, never document values.
  @Post('assist')
  async assist(
    @Param('id') id: string,
    @Body() dto: DocAssistDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<DocAssistResult> {
    return this.assistService.assist(
      { dbInstallId: id, fluiUserId: req.user.userId },
      dto.prompt,
      dto.conversation,
      {
        model: dto.model,
        provider: dto.provider,
        connectionId: dto.connectionId,
      },
      { database: dto.database, collection: dto.collection },
    );
  }

  @Get('connection-info')
  async connectionInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<DbConnectionInfo> {
    return this.docs.connectionInfo({
      dbInstallId: id,
      fluiUserId: req.user.userId,
    });
  }
}
