import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AppAccessGuard,
  AppAction,
} from '../../applications/guards/app-access.guard';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  AppProtection,
  AppProtectionService,
} from '../services/app-protection.service';
import {
  BeforeDeployOption,
  PreDeployBackupService,
} from '../services/pre-deploy-backup.service';
import { SetBeforeDeployDto } from '../dto/set-before-deploy.dto';

@ApiTags('Backups')
@ApiBearerAuth()
@Controller('applications/:id')
@UseGuards(AppAccessGuard)
export class AppProtectionController {
  constructor(
    private readonly protection: AppProtectionService,
    private readonly beforeDeploy: PreDeployBackupService,
  ) {}

  @Get('backup-protection')
  @AppAction(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'What protects this application off the cluster',
    description:
      'The backup policies covering the application, where they write and how their last run went.',
  })
  async get(
    @Param('id') id: string,
  ): Promise<AppProtection & { beforeDeploy: BeforeDeployOption | null }> {
    const [protection, beforeDeploy] = await Promise.all([
      this.protection.forApplication(id),
      this.beforeDeploy.optionFor(id),
    ]);
    return { ...protection, beforeDeploy };
  }

  @Put('backup-before-deploy')
  @AppAction(IAM_PERMISSION.APP_WRITE)
  @ApiOperation({
    summary: 'Take a backup before each deploy of this application',
    description:
      'A restore point for a continuous database (the deploy waits the few seconds it takes), a dump for a database kept by dumps and a copy of the other volumes (both started, not waited for), each under the policies that already protect the application.',
  })
  setBeforeDeploy(
    @Param('id') id: string,
    @Body() dto: SetBeforeDeployDto,
  ): Promise<BeforeDeployOption> {
    return this.beforeDeploy.setOption(id, dto);
  }
}
