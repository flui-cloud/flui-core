import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { DbImportService } from '../services/db-import.service';
import { DbImportViewDto, StartDbImportDto } from '../dto/db-import.dto';

const userOf = (req: Request) => req.user as AuthenticatedUser;

@ApiTags('Databases')
@ApiBearerAuth()
@Controller('applications/:id/import')
export class DbImportController {
  constructor(private readonly imports: DbImportService) {}

  @Get()
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary:
      'The latest import into this PostgreSQL or MariaDB, with how far it has got',
  })
  @ApiResponse({ status: 200, type: DbImportViewDto })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<DbImportViewDto | null> {
    return this.imports.view(userOf(req), id);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission(IAM_PERMISSION.MIGRATION_EXECUTE)
  @ApiOperation({
    summary:
      'Copy an external database of the same engine into this empty one, then keep it in step',
    description:
      'PostgreSQL: the source needs wal_level=logical and a user that can replicate; Flui copies the schema, then the data through logical replication, and adds on the source only a publication, a replication slot and, on tables without a primary key, a full replica identity, all removed at the end. MariaDB: the source needs binary logging in ROW format and a user with REPLICATION SLAVE, BINLOG MONITOR and RELOAD; Flui streams a consistent dump into this database and replicates the binary log from where the dump was taken, adding nothing on the source. Either way new changes keep arriving until the switch.',
  })
  @ApiResponse({ status: 202, type: DbImportViewDto })
  start(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartDbImportDto,
    @Req() req: Request,
  ): Promise<DbImportViewDto> {
    return this.imports.start(userOf(req), id, dto);
  }

  @Post('cutover')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission(IAM_PERMISSION.MIGRATION_EXECUTE)
  @ApiOperation({
    summary: 'Finish the import once writes to the source have stopped',
    description:
      'Waits until no change is left to apply, sets every sequence to the source value, then detaches from the source and removes what the import added there. Stop every write to the source first: Flui cannot stop them for you.',
  })
  @ApiResponse({ status: 202, type: DbImportViewDto })
  cutover(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<DbImportViewDto> {
    return this.imports.cutover(userOf(req), id);
  }

  @Delete()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission(IAM_PERMISSION.MIGRATION_EXECUTE)
  @ApiOperation({
    summary: 'Cancel a running import',
    description:
      'Stops following the source and removes what the import added there. What was already copied stays in this database.',
  })
  @ApiResponse({ status: 202, type: DbImportViewDto })
  abort(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<DbImportViewDto> {
    return this.imports.abort(userOf(req), id);
  }
}
