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
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { DbMigrationService } from '../services/db-migration.service';
import { CreateDbMigrationDto } from '../dto/create-db-migration.dto';

/**
 * Database migration machine (plan §6, inner core). Management-plane / admin
 * gated like the rest of the backup/lifecycle infra.
 *
 * The permissions on the routes below take nothing from anybody: the `backup`
 * section already admits only `full`, which is `cluster:manage` at global
 * scope, and both roles that hold it (`manager`, `owner`) hold
 * `migration:execute` too. They are here for the credential ceiling, which
 * reads `@RequirePermission` and `@AppAction` and nothing else —
 * without them a key scoped to "look at migrations" starts and aborts them
 * over plain HTTP. `app:read` on the reads and deliberately not `cluster:read`:
 * the lists answer with the caller's own migrations and a sandbox guest is
 * shown them for real, holding `app:read` and no cluster permission at all.
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
  @RequirePermission(IAM_PERMISSION.MIGRATION_EXECUTE)
  @ApiOperation({
    summary:
      'Migrate a database to another cluster (live replication or restore-from-backup)',
  })
  create(@Req() req: Request, @Body() dto: CreateDbMigrationDto) {
    return this.service.create(this.userId(req), dto);
  }

  @Get()
  @RequirePermission(IAM_PERMISSION.APP_READ)
  list(@Req() req: Request) {
    return this.service.list(this.userId(req));
  }

  @Get(':id')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  get(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post(':id/cutover')
  @RequirePermission(IAM_PERMISSION.MIGRATION_EXECUTE)
  @ApiOperation({ summary: 'Fire the cutover of a SYNCED manual migration' })
  cutover(@Param('id') id: string) {
    return this.service.cutover(id);
  }

  @Delete(':id')
  @RequirePermission(IAM_PERMISSION.MIGRATION_EXECUTE)
  @ApiOperation({
    summary: 'Abort a pre-cutover migration (tears the replication link down)',
  })
  abort(@Param('id') id: string) {
    return this.service.abort(id);
  }
}
