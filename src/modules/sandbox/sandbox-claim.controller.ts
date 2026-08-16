import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ApiKeyService } from '../auth/services/api-key.service';
import { setFluiSessionCookie } from '../auth/utils/session-cookie.util';
import { SANDBOX_CONFIG, SandboxConfig } from './sandbox.config';
import { SandboxReserveService } from './services/sandbox-reserve.service';
import {
  SandboxClaimResultDto,
  SandboxSessionDto,
} from './dto/sandbox-session.dto';
import { SandboxTenantEntity } from './entities/sandbox-tenant.entity';

@ApiTags('Sandbox')
@Controller('sandbox')
export class SandboxClaimController {
  constructor(
    private readonly reserve: SandboxReserveService,
    private readonly apiKeys: ApiKeyService,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  /**
   * Take one warm tenancy from the reserve and hand it to whoever asked.
   *
   * Public and unauthenticated by definition — the whole promise is "no signup".
   * What stands in for an account is the per-address limit and the fact that
   * everything handed out dies on a timer.
   */
  @Post('claim')
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 60_000, limit: 6 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Claim a sandbox tenancy',
    description:
      'Assigns a pre-built tenancy and returns a credential scoped to it. The countdown starts now, not when the tenancy was built.',
  })
  @ApiResponse({ status: 201, type: SandboxClaimResultDto })
  @ApiResponse({ status: 409, description: 'This address has claimed enough' })
  @ApiResponse({ status: 503, description: 'The reserve is empty' })
  async claim(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SandboxClaimResultDto> {
    if (!this.config.enabled) {
      throw new NotFoundException(
        'The sandbox is not enabled on this instance',
      );
    }
    if (!this.config.acceptingClaims) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'SANDBOX_CLOSED',
        message:
          'The sandbox is not accepting new visitors right now. Anyone already inside is unaffected.',
      });
    }

    const { tenant, expiresAt } = await this.reserve.claim(clientIp(req));

    // The credential expires with the tenancy, so a leaked token cannot outlive
    // the thing it opens.
    const { plaintext } = await this.apiKeys.generateApiKey(
      `sandbox-${tenant.namespace}`,
      tenant.userId!,
      expiresAt,
    );
    setFluiSessionCookie(res, plaintext);

    return {
      ...this.toSession(tenant),
      apiKey: plaintext,
      loginUrl: `https://${this.config.baseDomain}`,
    };
  }

  @Get('session')
  @ApiOperation({
    summary: 'The tenancy the caller is in, and how long is left of it',
    description:
      'Drives the permanent countdown. There is no email to warn anyone, so this is the only channel the sandbox has.',
  })
  @ApiResponse({ status: 200, type: SandboxSessionDto })
  async session(@Req() req: Request): Promise<SandboxSessionDto> {
    const user = req.user as AuthenticatedUser | undefined;
    const tenant = user?.userId
      ? await this.reserve.findActiveForUser(user.userId)
      : null;
    if (!tenant) {
      throw new NotFoundException('You are not in a sandbox tenancy');
    }
    return this.toSession(tenant);
  }

  private toSession(tenant: SandboxTenantEntity): SandboxSessionDto {
    const expiresAt = tenant.expiresAt ?? new Date();
    return {
      namespace: tenant.namespace,
      email: tenant.email,
      expiresAt: expiresAt.toISOString(),
      secondsRemaining: Math.max(
        0,
        Math.floor((expiresAt.getTime() - Date.now()) / 1000),
      ),
      ttlHours: this.config.ttlHours,
    };
  }
}

/**
 * Behind the ingress every request arrives from the same proxy, so the
 * forwarded address is the only thing that distinguishes one visitor from
 * another. It is spoofable, which is why it rate-limits rather than authorises.
 */
function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (first?.split(',')[0] ?? req.ip ?? 'unknown').trim();
}
