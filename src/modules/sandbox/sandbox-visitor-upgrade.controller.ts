import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ThrottlerStorage } from '@nestjs/throttler';
import { countOrRefuse } from '../../common/throttling/per-key-limit';
import { Public } from '../auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  CURRENT_API_KEY_ID,
  RequestWithApiKey,
} from '../auth/strategies/api-key.strategy';
import {
  VisitorLinkDto,
  VisitorLinkIntentDto,
  VisitorLinkIntentRequestDto,
  VisitorLinkRequestDto,
  VisitorUpgradeFinishDto,
  VisitorUpgradeFinishRequestDto,
  VisitorUpgradeIdpDto,
  VisitorUpgradeIdpRequestDto,
  VisitorUpgradeProvidersDto,
} from './dto/sandbox-visitor-upgrade.dto';
import { VisitorLinkService } from './visitors/visitor-link.service';
import { safeReturnPath } from './visitors/visitor-return';
import { VisitorUpgradeService } from './visitors/visitor-upgrade.service';
import { VISITOR_THROTTLER } from './visitors/visitor-admission.service';

type CallerRequest = Request & { user?: AuthenticatedUser } & RequestWithApiKey;

export const VISITOR_UPGRADE_NEEDS_PERSON_CODE = 'VISITOR_UPGRADE_NEEDS_PERSON';
export const VISITOR_UPGRADE_LIMIT_CODE = 'SANDBOX_VISITOR_UPGRADE_LIMIT';

const UPGRADE_STARTS = {
  name: 'sandbox-visitor-upgrade',
  ttlMs: 10 * 60_000,
  limit: 5,
  code: VISITOR_UPGRADE_LIMIT_CODE,
  message: 'Too many sign-ins started. Wait a few minutes and try again.',
};

/**
 * A visitor turning its visit into an account: with GitHub or Google on the
 * same user, or by email through a normal registration and a single-use link.
 * Only the person in the browser does this, never an agent key.
 */
@ApiTags('Sandbox')
@Controller('sandbox/visitor')
export class SandboxVisitorUpgradeController {
  constructor(
    private readonly upgrade: VisitorUpgradeService,
    private readonly links: VisitorLinkService,
    @Inject(VISITOR_THROTTLER) private readonly throttler: ThrottlerStorage,
  ) {}

  @Get('upgrade/providers')
  @ApiOperation({
    summary: 'The sign-ins a visitor can turn its visit into an account with',
  })
  @ApiResponse({ status: 200, type: VisitorUpgradeProvidersDto })
  providers(): Promise<VisitorUpgradeProvidersDto> {
    return this.upgrade.providers();
  }

  @Post('upgrade/idp')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start signing in with GitHub or Google as this visitor',
    description:
      'The visitor keeps its user, keys and history. Answers with the address the browser goes to; the browser comes back to the dashboard with `visitor=finish&flow=…`, or `visitor=upgrade-failed`.',
  })
  @ApiResponse({ status: 201, type: VisitorUpgradeIdpDto })
  @ApiResponse({ status: 404, description: 'That sign-in is not offered' })
  @ApiResponse({ status: 409, description: 'The caller is not a visitor' })
  @ApiResponse({ status: 429, description: 'Five starts per ten minutes' })
  async start(
    @Req() req: CallerRequest,
    @Body() body: VisitorUpgradeIdpRequestDto,
  ): Promise<VisitorUpgradeIdpDto> {
    const visitor = personOf(req);
    await countOrRefuse(this.throttler, `visitor:${visitor}`, UPGRADE_STARTS);
    return this.upgrade.start(
      visitor,
      body.provider,
      safeReturnPath(body.returnTo),
    );
  }

  @Get('upgrade/callback')
  @Public()
  @ApiOperation({
    summary: 'Where the identity provider sends the browser back',
    description:
      'Redirects to the dashboard with a single-use `flow` for the visitor that started the sign-in, or with `visitor=upgrade-failed`.',
  })
  @ApiQuery({ name: 'result', required: false })
  @ApiQuery({ name: 'id', required: false })
  @ApiQuery({ name: 'token', required: false })
  @ApiResponse({ status: 302, description: 'On to the dashboard' })
  async callback(
    @Query('result') result: unknown,
    @Query('id') id: unknown,
    @Query('token') token: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const target = await this.upgrade.callback({
      result: typeof result === 'string' ? result : undefined,
      id: typeof id === 'string' && id.length <= 128 ? id : undefined,
      token:
        typeof token === 'string' && token.length <= 4096 ? token : undefined,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(HttpStatus.FOUND, target);
  }

  @Post('upgrade/finish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finish signing in with GitHub or Google',
    description:
      'Sent by the same visitor that started it, with the `flow` the dashboard came back with. Idempotent.',
  })
  @ApiResponse({ status: 200, type: VisitorUpgradeFinishDto })
  @ApiResponse({ status: 404, description: 'Unknown, or another visitor’s' })
  @ApiResponse({ status: 410, description: 'Expired' })
  finish(
    @Req() req: CallerRequest,
    @Body() body: VisitorUpgradeFinishRequestDto,
  ): Promise<VisitorUpgradeFinishDto> {
    return this.upgrade.finish(personOf(req), body.flow);
  }

  @Post('link-intent')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Get a single-use link to add this visit to an account',
    description:
      'For the email way: the visitor registers or signs in normally, then the account sends the nonce to `POST /sandbox/visitor/link`.',
  })
  @ApiResponse({ status: 201, type: VisitorLinkIntentDto })
  @ApiResponse({ status: 409, description: 'The caller is not a visitor' })
  async linkIntent(
    @Req() req: CallerRequest,
    @Body() body: VisitorLinkIntentRequestDto,
  ): Promise<VisitorLinkIntentDto> {
    const visitor = await this.links.visitorOrRefuse(personOf(req));
    const intent = await this.links.createIntent(
      visitor.id,
      safeReturnPath(body?.returnTo),
    );
    return { nonce: intent.nonce, expiresAt: intent.expiresAt.toISOString() };
  }

  @Post('link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Add a visit to the signed-in account',
    description:
      'Moves the visitor’s keys, assistant history and agent decisions to the caller and ends the visitor. Idempotent for the same account.',
  })
  @ApiResponse({ status: 200, type: VisitorLinkDto })
  @ApiResponse({ status: 404, description: 'Unknown link' })
  @ApiResponse({ status: 409, description: 'Refused' })
  @ApiResponse({ status: 410, description: 'Expired or used' })
  link(
    @Req() req: CallerRequest,
    @Body() body: VisitorLinkRequestDto,
  ): Promise<VisitorLinkDto> {
    return this.links.link(personOf(req), body.nonce);
  }
}

function personOf(req: CallerRequest): string {
  const userId = req.user?.userId;
  if (!userId || req[CURRENT_API_KEY_ID]) {
    throw new ForbiddenException({
      statusCode: 403,
      code: VISITOR_UPGRADE_NEEDS_PERSON_CODE,
      message: 'Only the person in the browser can do this, not an API key.',
    });
  }
  return userId;
}
