import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { RELEASE } from '../../../config/release.config';
import { VersionResponseDto } from './dto/version-response.dto';

@ApiTags('Health')
@Public()
@Controller('version')
export class VersionController {
  @Get()
  @ApiOperation({
    summary: 'Platform version',
    description:
      'Returns the platform release version this API build belongs to, its pinned bootstrap ref, and the component image tags. Env overrides (FLUI_API_IMAGE_TAG / FLUI_WEB_IMAGE_TAG / FLUI_AUTHZ_IMAGE_TAG) win over the compiled-in pins so the values reflect what is actually deployed. Used by the dashboard version badge and the upgrade-available check.',
  })
  @ApiResponse({ status: 200, type: VersionResponseDto })
  getVersion(): VersionResponseDto {
    return {
      version: RELEASE.version,
      bootstrapRef: RELEASE.bootstrapRef,
      components: {
        fluiApi: process.env.FLUI_API_IMAGE_TAG ?? RELEASE.images.fluiApi,
        fluiWeb: process.env.FLUI_WEB_IMAGE_TAG ?? RELEASE.images.fluiWeb,
        fluiAuthz: process.env.FLUI_AUTHZ_IMAGE_TAG ?? RELEASE.images.fluiAuthz,
      },
    };
  }
}
