import { Controller, Get, Param, UseGuards } from '@nestjs/common';
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

@ApiTags('Backups')
@ApiBearerAuth()
@Controller('applications/:id')
@UseGuards(AppAccessGuard)
export class AppProtectionController {
  constructor(private readonly protection: AppProtectionService) {}

  @Get('backup-protection')
  @AppAction(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'What protects this application off the cluster',
    description:
      'The backup policies covering the application, where they write and how their last run went.',
  })
  get(@Param('id') id: string): Promise<AppProtection> {
    return this.protection.forApplication(id);
  }
}
