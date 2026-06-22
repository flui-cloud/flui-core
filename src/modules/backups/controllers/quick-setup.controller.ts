import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { QuickSetupService } from '../services/quick-setup.service';
import { QuickSetupDto } from '../dto/quick-setup.dto';
import { RequireSection } from '../../iam/decorators/require-section.decorator';

@ApiTags('Backups')
@ApiBearerAuth()
@Controller('clusters/:clusterId/backups')
@RequireSection('backup')
export class QuickSetupController {
  constructor(private readonly service: QuickSetupService) {}

  private userId(req: Request): string {
    const u = req.user as { userId?: string; id?: string } | undefined;
    return u?.id ?? u?.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  @Get('setup-options')
  async options(@Req() req: Request, @Param('clusterId') clusterId: string) {
    return this.service.getSetupOptions(this.userId(req), clusterId);
  }

  @Post('quick-setup')
  async start(
    @Req() req: Request,
    @Param('clusterId') clusterId: string,
    @Body() dto: QuickSetupDto,
  ) {
    return this.service.startQuickSetup(this.userId(req), clusterId, dto);
  }
}
