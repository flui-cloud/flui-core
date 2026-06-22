import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { BackupDestinationsService } from '../services/backup-destinations.service';
import { CreateBackupDestinationDto } from '../dto/create-backup-destination.dto';
import { RequireSection } from '../../iam/decorators/require-section.decorator';

@ApiTags('Backups')
@ApiBearerAuth()
@Controller('backup-destinations')
@RequireSection('backup')
export class BackupDestinationsController {
  constructor(private readonly service: BackupDestinationsService) {}

  private userId(req: Request): string {
    const u = req.user as { userId?: string; id?: string } | undefined;
    return u?.id ?? u?.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  @Post()
  async create(@Req() req: Request, @Body() dto: CreateBackupDestinationDto) {
    return this.service.create(this.userId(req), dto);
  }

  @Get()
  async list(@Req() req: Request) {
    return this.service.list(this.userId(req));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post(':id/test')
  async test(@Param('id') id: string) {
    return this.service.testConnection(id);
  }

  @Post(':id/refresh-usage')
  async refresh(@Param('id') id: string) {
    await this.service.refreshUsage(id);
    return { ok: true };
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.service.delete(id);
    return { ok: true };
  }
}
