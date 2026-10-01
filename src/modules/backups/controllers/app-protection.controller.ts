import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
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
import { SetBackupDecisionDto } from '../dto/set-backup-decision.dto';
import {
  AppBackupDecisionService,
  BackupDecisionView,
} from '../services/app-backup-decision.service';
import {
  NOT_BACKED_UP_CONSEQUENCE,
  backupDecisionClause,
} from '../utils/app-backup-decision.rules';

@ApiTags('Backups')
@ApiBearerAuth()
@Controller('applications/:id')
@UseGuards(AppAccessGuard)
export class AppProtectionController {
  constructor(
    private readonly protection: AppProtectionService,
    private readonly beforeDeploy: PreDeployBackupService,
    private readonly decisions: AppBackupDecisionService,
  ) {}

  @Get('backup-protection')
  @AppAction(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'What protects this application off the cluster',
    description:
      'The backup policies covering the application, where they write and how their last run went, and its coverage: `not_backed_up_by_choice` with `coverage.decision` (note, who, when) when a person decided it is not backed up.',
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

  @Put('backup-decision')
  @AppAction(IAM_PERMISSION.APP_WRITE)
  @ActionCycle({
    action: 'PUT /applications/:id/backup-decision',
    bind: ['id'],
    sentence: 'decide that application {id} is not backed up',
    clause: backupDecisionClause,
    consequence: NOT_BACKED_UP_CONSEQUENCE,
  })
  @ApiOperation({
    summary:
      'Decide that this application is not backed up, or back it up again',
    description:
      'With `notBackedUp: true` the application is no longer counted as unprotected or listed as needing a backup, and protecting its cluster gives it no policy. Backups already taken and the policies naming it are left as they are. `notBackedUp: false` takes the decision back; on a protected cluster the application gets its policy again.',
  })
  setBackupDecision(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: SetBackupDecisionDto,
  ): Promise<BackupDecisionView> {
    const user = req.user as AuthenticatedUser;
    return this.decisions.set(id, dto, user);
  }
}
