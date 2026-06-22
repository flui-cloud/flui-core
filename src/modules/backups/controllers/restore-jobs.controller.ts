import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { RestoreJobsService } from '../services/restore-jobs.service';
import {
  CreateRestoreJobDto,
  RestorePreviewDto,
} from '../dto/create-restore-job.dto';
import { RequireSection } from '../../iam/decorators/require-section.decorator';

@ApiTags('Backups')
@ApiBearerAuth()
@Controller('restore-jobs')
@RequireSection('backup')
export class RestoreJobsController {
  constructor(private readonly service: RestoreJobsService) {}

  private userId(req: Request): string {
    const u = req.user as { userId?: string; id?: string } | undefined;
    return u?.id ?? u?.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  @Post('preview')
  async preview(@Body() dto: RestorePreviewDto) {
    return this.service.preview(dto);
  }

  @Post()
  async create(@Req() req: Request, @Body() dto: CreateRestoreJobDto) {
    return this.service.create(this.userId(req), dto);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Get()
  async list(@Req() req: Request) {
    return this.service.listByUser(this.userId(req));
  }
}
