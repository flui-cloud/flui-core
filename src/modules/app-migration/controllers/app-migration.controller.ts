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
import { AppMigrationService } from '../services/app-migration.service';
import { CreateAppMigrationDto } from '../dto/create-app-migration.dto';

/**
 * Application migration machine (plan §6 step 2): move a live app's workload to
 * another cluster. Management-plane / admin gated like the rest of the
 * lifecycle infra.
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
  @ApiOperation({
    summary: "Migrate an application's workload to another cluster",
  })
  create(@Req() req: Request, @Body() dto: CreateAppMigrationDto) {
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
  @ApiOperation({
    summary: 'Fire the cutover of a READY manual migration (rebind + DNS flip)',
  })
  cutover(@Param('id') id: string) {
    return this.service.cutover(id);
  }

  @Post(':id/destroy-source')
  @ApiOperation({
    summary:
      'Destroy the drained source workload after a completed migration (plan §6 DESTROY)',
  })
  destroySource(@Param('id') id: string) {
    return this.service.destroySource(id);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Abort a pre-cutover migration (tears the destination workload down)',
  })
  abort(@Param('id') id: string) {
    return this.service.abort(id);
  }
}
