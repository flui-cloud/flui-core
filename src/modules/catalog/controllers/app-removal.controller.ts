import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApplicationService } from '../../applications/services/application.service';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import {
  AppAccessGuard,
  AppAction,
} from '../../applications/guards/app-access.guard';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CatalogInstallerService } from '../services/catalog-installer.service';
import { CatalogInstallStatus } from '../enums/catalog-install-status.enum';
import { AppRemovalResponseDto } from '../dto/app-removal-response.dto';
import { RemovalPreviewDto } from '../dto/removal-preview.dto';
import { RemovalPreviewService } from '../services/removal-preview.service';

/**
 * Remove an application the way it was installed, decided server-side.
 *
 * The caller names one application and gets back one answer; which of the two
 * removals ran is the API's problem, not the caller's. That routing used to
 * live in the MCP tool layer — three reads and a write with client-visible gaps
 * between them — and the gaps are what this route exists to close: a component
 * of a multi-component install maps to the SAME install, so a client that reads
 * the install's state, decides, and only then asks for the uninstall can fire a
 * second uninstall for a sibling component in between. Here the read and the
 * decision happen inside one request.
 *
 * `DELETE /applications/:id` stays what it is — remove exactly this
 * application — and is the right call when that is genuinely what is meant.
 */
@ApiTags('Applications')
@ApiBearerAuth()
@Controller('applications/:id')
@UseGuards(AppAccessGuard)
export class AppRemovalController {
  constructor(
    private readonly applications: ApplicationService,
    private readonly installer: CatalogInstallerService,
    private readonly deploy: ApplicationDeployService,
    private readonly preview: RemovalPreviewService,
  ) {}

  @Get('removal-preview')
  @AppAction(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'What removing this application would take away',
    description:
      'The same routing decision the removal itself makes — a component of a ' +
      'catalog install previews the WHOLE install — plus the storage that ' +
      'goes with it, read from the cluster. `dataWarning` is the one sentence ' +
      'every surface shows before it asks. When `volumesKnown` is false the ' +
      'cluster could not be read, and an empty list means "not known", never ' +
      '"nothing".',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 200, type: RemovalPreviewDto })
  @ApiResponse({ status: 404, description: 'Application not found' })
  async removalPreview(@Param('id') id: string): Promise<RemovalPreviewDto> {
    return this.preview.preview(id);
  }

  @Delete('install')
  @AppAction(IAM_PERMISSION.APP_DELETE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Remove an application together with whatever it was installed as',
    description:
      'An application that belongs to a catalog install removes the WHOLE ' +
      'install (every component); a standalone application removes itself. ' +
      'A removal already underway is reported as such instead of being ' +
      'started again — the components of one install all go together, so a ' +
      'second call for a sibling component must not queue a second uninstall.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 202, type: AppRemovalResponseDto })
  @ApiResponse({ status: 404, description: 'Application not found' })
  async remove(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<AppRemovalResponseDto> {
    const userId = (req.user as AuthenticatedUser | undefined)?.userId;
    const app = await this.applications.findById(id);
    const install = await this.installer.findInstallByApplicationId(
      id,
      app.clusterId,
    );

    if (!install) {
      const operation = await this.deploy.deleteApplication(id, userId);
      return {
        removed: 'application',
        operationId: operation.id,
        status: operation.status,
        done: false,
        label: `Delete ${app.name}`,
      };
    }

    if (
      install.status === CatalogInstallStatus.UNINSTALLING ||
      install.status === CatalogInstallStatus.UNINSTALLED
    ) {
      const done = install.status === CatalogInstallStatus.UNINSTALLED;
      return {
        removed: 'catalog-install',
        operationId: install.operationId ?? '',
        status: done ? 'COMPLETED' : 'IN_PROGRESS',
        done,
        alreadyUnderway: true,
        label: `Uninstall ${install.displayName}`,
      };
    }

    const { operation } = await this.installer.uninstall(install.id, userId);
    return {
      removed: 'catalog-install',
      operationId: operation.id,
      status: operation.status,
      done: false,
      label: `Uninstall ${install.displayName}`,
    };
  }
}
