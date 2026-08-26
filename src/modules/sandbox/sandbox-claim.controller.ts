import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Query,
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
import { ApiKeyStrategy } from '../auth/strategies/api-key.strategy';
import { extractJwtFromFluiSessionCookie } from '../auth/utils/cookie-extractor.util';
import { setFluiSessionCookie } from '../auth/utils/session-cookie.util';
import { SANDBOX_CONFIG, SandboxConfig } from './sandbox.config';
import { SandboxReserveService } from './services/sandbox-reserve.service';
import {
  SandboxClaimResultDto,
  SandboxSaveRequestDto,
  SandboxSaveResultDto,
  SandboxSessionDto,
} from './dto/sandbox-session.dto';
import { SandboxResumeMailService } from './services/sandbox-resume-mail.service';
import { SandboxEntryService } from './services/sandbox-entry.service';
import { SandboxTenantEntity } from './entities/sandbox-tenant.entity';

@ApiTags('Sandbox')
@Controller('sandbox')
export class SandboxClaimController {
  constructor(
    private readonly reserve: SandboxReserveService,
    private readonly apiKeys: ApiKeyService,
    private readonly apiKeyStrategy: ApiKeyStrategy,
    private readonly resumeMail: SandboxResumeMailService,
    private readonly entry: SandboxEntryService,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  /**
   * Take one warm tenancy from the reserve and hand it to whoever asked — or
   * give back the one the caller already has.
   *
   * Public and unauthenticated by definition — the whole promise is "no signup".
   * What stands in for an account is the per-address limit and the fact that
   * everything handed out dies on a timer.
   *
   * Resuming is decided here and not only on the page, because the page is not
   * the thing that must be right: a second click, a stale tab or a prefetch used
   * to spend a real tenancy from the reserve *and* a turn against the caller's
   * own address limit — a brake meant for abuse, closing the door on the person
   * it was protecting.
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

    const existing = await this.tenancyOf(req);
    if (existing) {
      // No new credential: the one this browser is holding still opens it, and a
      // second key for the same tenancy is one more thing that can leak.
      return { ...this.toSession(existing), resumed: true };
    }

    const { tenant, expiresAt } = await this.reserve.claim(clientIp(req));

    // The credential expires with the tenancy, so a leaked token cannot outlive
    // the thing it opens.
    const { plaintext } = await this.apiKeys.generateApiKey(
      `sandbox-${tenant.namespace}`,
      tenant.userId!,
      expiresAt,
    );
    setFluiSessionCookie(res, plaintext, expiresAt);

    return { ...this.toSession(tenant), apiKey: plaintext, resumed: false };
  }

  /**
   * The live tenancy behind the caller's session cookie, if there is one.
   *
   * Never throws: an expired, revoked or absent credential is simply "no
   * tenancy", and the caller goes on to be given a fresh one.
   */
  private async tenancyOf(req: Request): Promise<SandboxTenantEntity | null> {
    const token = extractJwtFromFluiSessionCookie(req);
    return token ? this.tenancyForToken(token) : null;
  }

  /** Never throws: an expired, revoked or invented credential is "no tenancy". */
  private async tenancyForToken(
    token: string,
  ): Promise<SandboxTenantEntity | null> {
    try {
      const user = await this.apiKeyStrategy.validate(token);
      return user.userId
        ? await this.reserve.findActiveForUser(user.userId)
        : null;
    } catch {
      return null;
    }
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

  /**
   * "Save my sandbox — mail me the link."
   *
   * The address is asked for here, inside, and never at the door: a form before
   * the visitor has seen anything works against the only reason the demo exists.
   * It is used once, to send one link, and it is not stored — the tenancy row
   * has no column for it and gains none.
   *
   * The link carries a credential for this tenancy and nothing else. It is worth
   * exactly what the browser that asked for it already holds, and it stops
   * working when the tenancy is deleted.
   */
  @Post('save')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 600_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mail yourself the way back into this sandbox' })
  @ApiResponse({ status: 200, type: SandboxSaveResultDto })
  async save(
    @Req() req: Request,
    @Body() dto: SandboxSaveRequestDto,
  ): Promise<SandboxSaveResultDto> {
    const user = req.user as AuthenticatedUser | undefined;
    const tenant = user?.userId
      ? await this.reserve.findActiveForUser(user.userId)
      : null;
    if (!tenant)
      throw new NotFoundException('You are not in a sandbox tenancy');

    const email = dto?.email?.trim();
    if (!email || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException('That does not look like an email address');
    }

    const expiresAt = tenant.expiresAt ?? new Date();
    const { plaintext } = await this.apiKeys.generateApiKey(
      `sandbox-resume-${tenant.namespace}`,
      tenant.userId!,
      expiresAt,
    );

    const outcome = await this.resumeMail.sendResumeLink({
      to: email,
      resumeLink: this.entry.resumeLink(plaintext),
      hoursLeft: (expiresAt.getTime() - Date.now()) / 3_600_000,
    });

    return {
      sent: outcome.sent,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * The other end of that link.
   *
   * Public, because whoever follows it is by definition not signed in on this
   * device. It turns the token into the same httpOnly cookie a claim sets and
   * then redirects to the bare dashboard, so the credential does not sit in the
   * address bar or in the browser history of the machine it opened on.
   */
  @Get('resume')
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Follow a saved link back into a sandbox' })
  @ApiResponse({ status: 302, description: 'Redirected into the sandbox' })
  async resume(
    @Query('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    const tenant = token ? await this.tenancyForToken(token) : null;
    if (!tenant?.expiresAt) {
      // Back to the door, not to `/login`: a guest has no password, so a sign-in
      // screen is a dead end for the one person who can reach it. What it says
      // is that the sandbox is gone, which is true whether the link expired or
      // was never real — the two must look the same from outside.
      res.redirect(`${this.entry.entryUrl}?expired=1`);
      return;
    }
    setFluiSessionCookie(res, token, tenant.expiresAt);
    res.redirect(this.entry.origin);
  }

  private toSession(tenant: SandboxTenantEntity): SandboxSessionDto {
    const expiresAt = tenant.expiresAt ?? new Date();
    return {
      expiresAt: expiresAt.toISOString(),
      secondsRemaining: Math.max(
        0,
        Math.floor((expiresAt.getTime() - Date.now()) / 1000),
      ),
      ttlHours: this.config.ttlHours,
      loginUrl: this.entry.origin,
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
