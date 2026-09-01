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
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AppMigrationService } from '../services/app-migration.service';
import { CreateAppMigrationDto } from '../dto/create-app-migration.dto';

/**
 * Application migration machine (plan §6 step 2): move a live app's workload to
 * another cluster. Management-plane / admin gated like the rest of the
 * lifecycle infra.
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
@ApiTags('App Migration')
@ApiBearerAuth()
@Controller('app-migrations')
@RequireSection('backup')
export class AppMigrationController {
  constructor(private readonly service: AppMigrationService) {}

  private userId(req: Request): string {
    const u = req.user as { userId?: string; id?: string } | undefined;
    return u?.id ?? u?.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  @Post()
  @RequirePermission(IAM_PERMISSION.MIGRATION_EXECUTE)
  @ApiOperation({
    summary: "Migrate an application's workload to another cluster",
  })
  create(@Req() req: Request, @Body() dto: CreateAppMigrationDto) {
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
    action: 'POST /app-migrations/:id/cutover',
    bind: ['id'],
    sentence: 'cut application migration {id} over to the destination cluster',
    consequence:
      'The application is served from the destination cluster and its name is repointed there; the source workload stops taking traffic.',
  })
  @ApiOperation({
    summary: 'Fire the cutover of a READY manual migration (rebind + DNS flip)',
  })
  cutover(@Param('id') id: string) {
    return this.service.cutover(id);
  }

  @Post(':id/destroy-source')
  @RequirePermission(IAM_PERMISSION.MIGRATION_EXECUTE)
  @ActionCycle({
    action: 'POST /app-migrations/:id/destroy-source',
    bind: ['id'],
    sentence:
      'destroy the source workload that application migration {id} moved ' +
      'away from — it does not come back',
  })
  @ApiOperation({
    summary:
      'Destroy the drained source workload after a completed migration (plan §6 DESTROY)',
  })
  destroySource(@Param('id') id: string) {
    return this.service.destroySource(id);
  }

  @Delete(':id')
  @RequirePermission(IAM_PERMISSION.MIGRATION_EXECUTE)
  @ActionCycle({
    action: 'DELETE /app-migrations/:id',
    bind: ['id'],
    sentence:
      'abort application migration {id}, and tear down the destination ' +
      'workload it had already built',
  })
  @ApiOperation({
    summary:
      'Abort a pre-cutover migration (tears the destination workload down)',
  })
  abort(@Param('id') id: string) {
    return this.service.abort(id);
  }
}
