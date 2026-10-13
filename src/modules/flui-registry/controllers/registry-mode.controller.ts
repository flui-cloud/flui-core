import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import {
  EnableFluiRegistryDto,
  RegistryModeStatusDto,
} from '../dto/registry-mode.dto';
import { RegistryModeService } from '../services/registry-mode.service';

const storageClause = (body: unknown): string | undefined => {
  const storage = (body as { storage?: unknown } | undefined)?.storage;
  if (storage === 's3') return 'keeping images in the connected bucket';
  if (storage === 'volume') return 'keeping images on a volume';
  return undefined;
};

/**
 * Which registry new builds push to. The installation's own setting, like its
 * GitHub integration and the registry's bucket, so the same permission
 * manages it.
 */
@ApiTags('Registry')
@ApiBearerAuth()
@RequirePermission(IAM_PERMISSION.INTEGRATION_MANAGE)
@Controller('registry')
export class RegistryModeController {
  constructor(private readonly modes: RegistryModeService) {}

  @Get('mode')
  @ApiOperation({
    summary:
      'Where new builds push their images, where the Flui registry keeps them, and whether it is ready',
  })
  @ApiResponse({ status: 200, type: RegistryModeStatusDto })
  status(): Promise<RegistryModeStatusDto> {
    return this.modes.status();
  }

  @Post('enable')
  @ActionCycle({
    action: 'POST /registry/enable',
    sentence:
      'switch this installation to the image registry Flui runs on its control cluster',
    clause: storageClause,
    consequence:
      'The registry starts on the control cluster and new builds push to it; applications already running keep the images they have.',
  })
  @ApiOperation({
    summary: 'Use the Flui registry for new builds',
    description:
      'Puts the registry on the control cluster, then records the choice so it holds across restarts. Refuses a bucket when none is connected, and changing between a volume and a bucket once the registry runs. Applications built before keep their current images. Poll GET /registry/mode until ready.',
  })
  @ApiResponse({ status: 201, type: RegistryModeStatusDto })
  @ApiResponse({
    status: 400,
    description: 'No public address for the registry, or no bucket connected',
  })
  @ApiResponse({
    status: 409,
    description: 'The registry already keeps images somewhere else',
  })
  @ApiResponse({
    status: 503,
    description: 'The registry could not be put in place; nothing changed',
  })
  enable(
    @Body() dto: EnableFluiRegistryDto,
    @Req() req: Request,
  ): Promise<RegistryModeStatusDto> {
    const user = req.user as AuthenticatedUser | undefined;
    return this.modes.enable(dto.storage, user?.userId ?? null);
  }

  @Post('disable')
  @ActionCycle({
    action: 'POST /registry/disable',
    sentence:
      'send this installation’s new builds back to GitHub Container Registry',
    consequence:
      'New builds push to GitHub Container Registry and the Flui registry stops; its volume or bucket is kept.',
  })
  @ApiOperation({
    summary: 'Send new builds back to GitHub Container Registry',
    description:
      'Allowed only while no application runs images from the Flui registry; otherwise refused with their names. Stops the registry first and keeps its volume or bucket; when it cannot be stopped nothing changes.',
  })
  @ApiResponse({ status: 201, type: RegistryModeStatusDto })
  @ApiResponse({
    status: 409,
    description: 'Applications still run images from the Flui registry',
  })
  @ApiResponse({
    status: 503,
    description:
      'The registry could not be stopped; new builds still push to it',
  })
  disable(@Req() req: Request): Promise<RegistryModeStatusDto> {
    const user = req.user as AuthenticatedUser | undefined;
    return this.modes.disable(user?.userId ?? null);
  }
}
