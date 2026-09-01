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
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { fullMigrationClause } from '../migration-clause';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { FullMigrationService } from '../services/full-migration.service';
import { CreateFullMigrationDto } from '../dto/create-full-migration.dto';

/**
 * Full-app migration orchestrator (MVP-5c): move a live app + its managed
 * Postgres to another cluster and rewire the DB connection. Management-plane
 * gated like the rest of the lifecycle infra.
 *
 * The permissions on the routes below take nothing from anybody: the `backup`
 * section already admits only `full`, which is `cluster:manage` at global
 * scope, and both roles that hold it (`maintainer`, `owner`) hold
 * `migration:execute` too. They are here for the credential ceiling, which
 * reads `@RequirePermission` and `@AppAction` and nothing else —
 * without them a key scoped to "look at migrations" starts and aborts them
 * over plain HTTP. `app:read` on the reads and deliberately not `cluster:read`:
 * the lists answer with the caller's own migrations and a sandbox guest is
 * shown them for real, holding `app:read` and no cluster permission at all.
 */
@ApiTags('Full Migration')
@ApiBearerAuth()
@Controller('full-migrations')
@RequireSection('backup')
export class FullMigrationController {
  constructor(private readonly service: FullMigrationService) {}

  private userId(req: Request): string {
    const u = req.user as { userId?: string; id?: string } | undefined;
    return u?.id ?? u?.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  @Post()
  @RequirePermission(IAM_PERMISSION.MIGRATION_EXECUTE)
  // Every call asks. The migration does not exist until this call makes it, so
  // there is no id an "always" could be pinned to, and a standing yes would
  // cover every future move of any application.
  @ActionCycle({
    action: 'POST /full-migrations',
    sentence:
      'start moving a live application and its database to another cluster',
    clause: fullMigrationClause,
    consequence:
      'A second copy of both is built on the destination and kept in step with the live one, taking capacity there. Unless the request asked for a manual cutover, the migration then finishes by itself: application and database are served from the destination cluster and the source stops taking traffic, without asking again.',
  })
  @ApiOperation({
    summary: 'Migrate a live app together with its managed Postgres',
  })
  create(@Req() req: Request, @Body() dto: CreateFullMigrationDto) {
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
  @ActionCycle({
    action: 'POST /full-migrations/:id/cutover',
    bind: ['id'],
    sentence:
      'cut migration {id} over to its destination, application and database together',
    consequence:
      'Both are served from the destination cluster from that moment, and the source keeps its data but stops taking traffic.',
  })
  @ApiOperation({ summary: 'Fire the joint cutover of a READY full-migration' })
  cutover(@Param('id') id: string) {
    return this.service.cutover(id);
  }

  @Post(':id/destroy-source')
  @RequirePermission(IAM_PERMISSION.MIGRATION_EXECUTE)
  @ActionCycle({
    action: 'POST /full-migrations/:id/destroy-source',
    bind: ['id'],
    sentence:
      'destroy the source application and database that migration {id} ' +
      'moved away from — they do not come back',
  })
  @ApiOperation({
    summary: 'Destroy the drained source app workload after completion',
  })
  destroySource(@Param('id') id: string) {
    return this.service.destroySource(id);
  }

  @Delete(':id')
  @RequirePermission(IAM_PERMISSION.MIGRATION_EXECUTE)
  @ActionCycle({
    action: 'DELETE /full-migrations/:id',
    bind: ['id'],
    sentence:
      'abort migration {id}, and tear down the destination application ' +
      'and database it had already built',
  })
  @ApiOperation({ summary: 'Abort a pre-cutover full-migration (both legs)' })
  abort(@Param('id') id: string) {
    return this.service.abort(id);
  }
}
