import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { RELEASE } from '../../../config/release.config';
import { VersionResponseDto } from './dto/version-response.dto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import specPackage = require('@flui-cloud/spec/package.json');

/**
 * The manifest contract this build validates against, named so anyone — a
 * person, or an agent that has never seen Flui — can fetch the exact schema
 * rather than the newest one published.
 *
 * Pinned deliberately. The floating URL resolves to whatever the registry has
 * today, which is not what this installation enforces: while this was written
 * npm was four minor versions ahead of the package compiled in here, so an
 * author following the unpinned link would have been handed a contract nothing
 * on this cluster agrees to.
 */
const SPEC_VERSION = (specPackage as { version: string }).version;
const SCHEMA_URL = `https://unpkg.com/@flui-cloud/spec@${SPEC_VERSION}/schemas/application.v1beta1.json`;

@ApiTags('Health')
@Public()
@Controller('version')
export class VersionController {
  @Get()
  @ApiOperation({
    summary: 'Platform version',
    description:
      'Returns the platform release version this API build belongs to, its pinned bootstrap ref, the component image tags, and the flui.yaml manifest contract this build validates against — pinned to the exact schema, so an author or an agent fetches what this installation enforces rather than the newest one published. Env overrides (FLUI_API_IMAGE_TAG / FLUI_WEB_IMAGE_TAG / FLUI_AUTHZ_IMAGE_TAG) win over the compiled-in pins so the values reflect what is actually deployed. Used by the dashboard version badge and the upgrade-available check.',
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
      manifestSpec: {
        package: '@flui-cloud/spec',
        version: SPEC_VERSION,
        applicationSchemaUrl: SCHEMA_URL,
      },
    };
  }
}
