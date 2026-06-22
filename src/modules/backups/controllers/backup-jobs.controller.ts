import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { BackupJobsService } from '../services/backup-jobs.service';
import { CreateBackupJobDto } from '../dto/create-backup-job.dto';
import { RequireSection } from '../../iam/decorators/require-section.decorator';

@ApiTags('Backups')
@ApiBearerAuth()
@Controller('backup-jobs')
@RequireSection('backup')
export class BackupJobsController {
  constructor(private readonly service: BackupJobsService) {}

  private userId(req: Request): string {
    const u = req.user as { userId?: string; id?: string } | undefined;
    return u?.id ?? u?.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  @Post()
  async create(@Req() req: Request, @Body() dto: CreateBackupJobDto) {
    return this.service.createOnDemand(this.userId(req), dto);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Get('cluster/:clusterId')
  async listByCluster(@Param('clusterId') clusterId: string) {
    return this.service.listByCluster(clusterId);
  }
}
