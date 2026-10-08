import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SANDBOX_CONFIG, SandboxConfig } from './sandbox.config';
import { SandboxReserveService } from './services/sandbox-reserve.service';
import { SandboxSessionDto } from './dto/sandbox-session.dto';
import { SandboxEntryService } from './services/sandbox-entry.service';
import { SandboxTenantEntity } from './entities/sandbox-tenant.entity';
import { SANDBOX_GUEST_REQUEST } from './guards/sandbox-fence.guard';
import { SANDBOX_ACTIVITY, SandboxActivity } from './gate/sandbox-activity';

/**
 * A guest arrives by signing in, and gets an area at their first deploy (see
 * `SandboxSlotGateService`). What is left here is the one read the interface
 * needs: the area the caller holds, and how long it has.
 */
@ApiTags('Sandbox')
@Controller('sandbox')
export class SandboxClaimController {
  constructor(
    private readonly reserve: SandboxReserveService,
    private readonly entry: SandboxEntryService,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
    @Inject(SANDBOX_ACTIVITY) private readonly activity: SandboxActivity,
  ) {}

  /**
   * "Keep my apps": an action like any other, so it moves the guest's
   * applications' deadline the way deploying would, never beyond their
   * longest lifetime.
   */
  @Post('keep')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Keep the applications in your demo space for longer',
  })
  @ApiResponse({ status: 200, type: SandboxSessionDto })
  async keep(@Req() req: Request): Promise<SandboxSessionDto> {
    const user = req.user as AuthenticatedUser | undefined;
    if (user?.userId) await this.activity.touch(user.userId);
    return this.session(req);
  }

  @Get('session')
  @ApiOperation({
    summary: 'Whether the caller is a demo guest, and the area they hold',
    description:
      'Answers 404 to anyone who is not a demo guest. A guest who has only looked around gets hasArea: false; their first deploy takes an area.',
  })
  @ApiResponse({ status: 200, type: SandboxSessionDto })
  async session(@Req() req: Request): Promise<SandboxSessionDto> {
    const marked = req as Request & { [SANDBOX_GUEST_REQUEST]?: unknown };
    if (marked[SANDBOX_GUEST_REQUEST] === undefined) {
      throw new NotFoundException('You are not a demo guest');
    }
    const user = req.user as AuthenticatedUser | undefined;
    const tenant = user?.userId
      ? await this.reserve.findActiveForUser(user.userId)
      : null;
    return this.toSession(tenant);
  }

  private toSession(tenant: SandboxTenantEntity | null): SandboxSessionDto {
    const expiresAt = tenant?.expiresAt ?? null;
    return {
      hasArea: tenant !== null,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      secondsRemaining: expiresAt
        ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
        : 0,
      ttlHours: this.config.ttlHours,
      workloadTtlHours: this.config.workloadTtlHours,
      loginUrl: this.entry.origin,
    };
  }
}
