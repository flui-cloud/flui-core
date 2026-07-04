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
import { FullMigrationService } from '../services/full-migration.service';
import { CreateFullMigrationDto } from '../dto/create-full-migration.dto';

/**
 * Full-app migration orchestrator (MVP-5c): move a live app + its managed
 * Postgres to another cluster and rewire the DB connection. Management-plane
 * gated like the rest of the lifecycle infra.
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
  @ApiOperation({
    summary: 'Migrate a live app together with its managed Postgres',
  })
  create(@Req() req: Request, @Body() dto: CreateFullMigrationDto) {
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
  @ApiOperation({ summary: 'Fire the joint cutover of a READY full-migration' })
  cutover(@Param('id') id: string) {
    return this.service.cutover(id);
  }

  @Post(':id/destroy-source')
  @ApiOperation({
    summary: 'Destroy the drained source app workload after completion',
  })
  destroySource(@Param('id') id: string) {
    return this.service.destroySource(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Abort a pre-cutover full-migration (both legs)' })
  abort(@Param('id') id: string) {
    return this.service.abort(id);
  }
}
