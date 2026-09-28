import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { SECTION } from '../../iam/constants/iam-sections';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { InstallValuesService } from '../services/install-values.service';
import {
  InstallValuesPlan,
  InstallValuesResult,
} from '../interfaces/install-values.interface';
import {
  ApplyInstallValuesDto,
  PlanInstallValuesDto,
} from '../dto/install-values.dto';

@ApiTags('Platform Updates')
@ApiBearerAuth()
@Controller('platform/updates/manifests/values')
@RequireSection(SECTION.INFRASTRUCTURE)
export class InstallValuesController {
  constructor(private readonly installValues: InstallValuesService) {}

  @Post('plan')
  @RequirePermission(IAM_PERMISSION.PLATFORM_UPDATE)
  @ApiOperation({
    summary:
      'Which values a cluster master was built with, proven file by file',
    description:
      'For an installation that predates the record the installer now keeps. Without a clusterId, the control cluster. Gathers candidate values from Flui and the running platform, and keeps one only when rendering a file with it reproduces the copy on the master exactly. Reads only digests from the master, never supplies a secret, and writes nothing. The plan id it returns is what the apply call must be given.',
  })
  plan(@Body() body: PlanInstallValuesDto): Promise<InstallValuesPlan> {
    return this.installValues.plan(body?.clusterId);
  }

  @Post('apply')
  @RequirePermission(IAM_PERMISSION.PLATFORM_UPDATE)
  @ApiOperation({
    summary: 'Record the proven values of a reconstruction that was previewed',
    description:
      'Recomputes the reconstruction and refuses if it differs from the plan. Writes only proven values, and never over a record the installer or an earlier reconstruction already wrote.',
  })
  apply(@Body() body: ApplyInstallValuesDto): Promise<InstallValuesResult> {
    return this.installValues.apply(body.planId, body.clusterId);
  }
}
