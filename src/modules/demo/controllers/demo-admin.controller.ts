import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Admin } from '../../auth/decorators/admin.decorator';
import { AdminGuard } from '../../auth/guards/admin.guard';
import { DemoStateService } from '../services/demo-state.service';
import { DemoOrchestratorService } from '../services/demo-orchestrator.service';
import { DemoProberService } from '../services/demo-prober.service';
import { DemoConfigEntity } from '../entities/demo-config.entity';
import { UpdateDemoConfigDto } from '../dto/update-demo-config.dto';

@ApiTags('demo')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Admin()
@Controller('demo/admin')
export class DemoAdminController {
  constructor(
    private readonly state: DemoStateService,
    private readonly orchestrator: DemoOrchestratorService,
    private readonly prober: DemoProberService,
  ) {}

  @Get('config')
  getConfig(): Promise<DemoConfigEntity> {
    return this.state.get();
  }

  @Put('config')
  async updateConfig(
    @Req() req: Request,
    @Body() dto: UpdateDemoConfigDto,
  ): Promise<DemoConfigEntity> {
    const user = req.user as { id?: string; userId?: string } | undefined;
    const ownerUserId = user?.id ?? user?.userId;
    return this.state.patch({ ...dto, ownerUserId });
  }

  @Post('enable')
  async enable(): Promise<DemoConfigEntity> {
    const cfg = await this.state.get();
    const missing: string[] = [];
    if (!cfg.appId) missing.push('appId');
    if (!cfg.dbAppId) missing.push('dbAppId');
    if (!cfg.clusterAId) missing.push('clusterAId');
    if (!cfg.clusterBId) missing.push('clusterBId');
    if (!cfg.ownerUserId) missing.push('ownerUserId');
    if (!cfg.probeUrl) missing.push('probeUrl');
    if (missing.length) {
      throw new BadRequestException(
        `Configure the demo before enabling — missing: ${missing.join(', ')}`,
      );
    }
    return this.state.patch({ enabled: true });
  }

  @Post('disable')
  disable(): Promise<DemoConfigEntity> {
    return this.state.patch({ enabled: false });
  }

  @Post('trigger')
  async trigger(): Promise<{ triggered: true }> {
    await this.orchestrator.triggerNow();
    return { triggered: true };
  }

  @Post('reset')
  reset(): Promise<DemoConfigEntity> {
    return this.orchestrator.reset();
  }

  @Post('reset-counters')
  async resetCounters(): Promise<{ ok: true }> {
    await this.prober.resetCounters();
    return { ok: true };
  }
}
