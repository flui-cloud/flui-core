import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import {
  SANDBOX_ALLOWLIST,
  SANDBOX_DENIED_AREAS,
} from './constants/sandbox-fence';
import { SandboxLimitsDto } from './dto/sandbox-limits.dto';
import { DEFAULT_SANDBOX_QUOTA } from './constants/sandbox-quota.manifest';

@ApiTags('Sandbox')
@Controller('sandbox')
export class SandboxController {
  /**
   * Public on purpose. "What is disabled here, and why" is a promise made before
   * anyone signs in — a visitor deciding whether to click should be able to read
   * it, and a guest hitting a refusal should be able to check it without asking.
   */
  @Get('limits')
  @Public()
  @ApiOperation({
    summary: 'What a sandbox guest may do, what it may not, and the quota',
    description:
      'The same allowlist the fence enforces, served as documentation. Nothing here is advisory: a route absent from `allowed` is refused by the API, not merely hidden.',
  })
  @ApiResponse({ status: 200, type: SandboxLimitsDto })
  limits(): SandboxLimitsDto {
    return {
      allowed: SANDBOX_ALLOWLIST.map((r) => ({
        routes: r.verbs.map((v) => `${v} ${r.pattern}`),
        why: r.why,
      })),
      denied: SANDBOX_DENIED_AREAS,
      quota: {
        cpu: `${DEFAULT_SANDBOX_QUOTA.cpuLimit} cores`,
        memory: DEFAULT_SANDBOX_QUOTA.memoryLimit,
        storage: DEFAULT_SANDBOX_QUOTA.storage,
        pods: DEFAULT_SANDBOX_QUOTA.pods,
      },
    };
  }
}
