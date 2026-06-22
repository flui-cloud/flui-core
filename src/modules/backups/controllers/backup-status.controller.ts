import { Controller, Get, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { BackupStatusService } from '../services/backup-status.service';
import { RequireSection } from '../../iam/decorators/require-section.decorator';

@ApiTags('Backups')
@ApiBearerAuth()
@Controller('backups')
@RequireSection('backup')
export class BackupStatusController {
  constructor(private readonly service: BackupStatusService) {}

  private userId(req: Request): string {
    const u = req.user as { userId?: string; id?: string } | undefined;
    return u?.id ?? u?.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  @Get('status')
  async status(@Req() req: Request) {
    return this.service.getStatus(this.userId(req));
  }
}
