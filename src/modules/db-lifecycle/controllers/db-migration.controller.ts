import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { DbMigrationService } from '../services/db-migration.service';
import { CreateDbMigrationDto } from '../dto/create-db-migration.dto';

/**
 * Database migration machine (plan §6, inner core). Management-plane / admin
 * gated like the rest of the backup/lifecycle infra.
 */
@ApiTags('DB Lifecycle')
@ApiBearerAuth()
@Controller('db-migrations')
@RequireSection('backup')
export class DbMigrationController {
  constructor(private readonly service: DbMigrationService) {}

  private userId(req: Request): string {
    const u = req.user as { userId?: string; id?: string } | undefined;
    return u?.id ?? u?.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  @Post()
  @ApiOperation({
    summary:
      'Migrate a database to another cluster (live replication or restore-from-backup)',
  })
  create(@Req() req: Request, @Body() dto: CreateDbMigrationDto) {
    return this.service.create(this.userId(req), dto);
  }

  @Get()
  list(@Req() req: Request) {
    return this.service.list(this.userId(req));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post(':id/cutover')
  @ApiOperation({ summary: 'Fire the cutover of a SYNCED manual migration' })
  cutover(@Param('id') id: string) {
    return this.service.cutover(id);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Abort a pre-cutover migration (tears the replication link down)',
  })
  abort(@Param('id') id: string) {
    return this.service.abort(id);
  }
}
