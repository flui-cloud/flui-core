import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import {
  SandboxVisitorAdmissionDto,
  SandboxVisitorAdmissionRequestDto,
} from './dto/sandbox-visitor-admission.dto';
import { VisitorAdmissionService } from './visitors/visitor-admission.service';
import {
  VisitorLoginService,
  authRequestIdOf,
} from './visitors/visitor-login.service';

/**
 * The visitors' entrance. Both routes are public: a visitor has no account
 * yet, and the sign-in route is where the identity provider sends the browser.
 */
@ApiTags('Sandbox')
@Controller('sandbox/visitor')
export class SandboxVisitorController {
  constructor(
    private readonly admissions: VisitorAdmissionService,
    private readonly login: VisitorLoginService,
  ) {}

  @Post('admission')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Get a single-use ticket to enter the demo as a visitor',
    description:
      'Counted per address and for the whole instance, and checked with Cloudflare Turnstile when the instance has a key for it. The ticket expires in two minutes and is passed as `login_hint` to the sign-in of the "try" application.',
  })
  @ApiResponse({ status: 201, type: SandboxVisitorAdmissionDto })
  @ApiResponse({ status: 403, description: 'The browser check failed' })
  @ApiResponse({ status: 429, description: 'Too many visitors' })
  @ApiResponse({ status: 503, description: 'Visitors are not taken' })
  admission(
    @Req() req: Request,
    @Body() body: SandboxVisitorAdmissionRequestDto,
  ): Promise<SandboxVisitorAdmissionDto> {
    return this.admissions.admit({
      ip: req.ip ?? req.socket?.remoteAddress ?? '',
      turnstileToken: body.turnstileToken,
      cli: body.cli === true,
    });
  }

  @Get('login')
  @Public()
  @ApiOperation({
    summary:
      'Sign a visitor in with no screen (called by the identity provider)',
    description:
      'Where the identity provider sends the sign-in of the "try" applications. Redirects to the address the provider returns, or to the dashboard sign-in page with `visitor=refused` and a reason.',
  })
  @ApiQuery({ name: 'authRequest', required: false })
  @ApiQuery({ name: 'requestId', required: false })
  @ApiResponse({
    status: 302,
    description: 'On to the application, or back to sign-in',
  })
  async enter(
    @Query('authRequest') authRequest: string | undefined,
    @Query('requestId') requestId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const target = await this.login.enter(
      authRequestIdOf(
        typeof authRequest === 'string' ? authRequest : undefined,
        typeof requestId === 'string' ? requestId : undefined,
      ),
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(HttpStatus.FOUND, target);
  }
}
