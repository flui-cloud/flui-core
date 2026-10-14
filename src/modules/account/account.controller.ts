import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { actorFromRequest } from '../auth/utils/actor.util';
import { RequestWithApiKey } from '../auth/strategies/api-key.strategy';
import { AccountService } from './account.service';
import {
  AccountDoneDto,
  AccountOverviewDto,
  AccountProfileDto,
  ChangeAccountPasswordDto,
  ConfirmWithPasswordDto,
  PasswordPolicyDto,
  StartTotpDto,
  TotpRegistrationDto,
  UpdateAccountProfileDto,
  VerifyTotpDto,
} from './dto/account.dto';

export const AGENT_MAY_NOT_MANAGE_ACCOUNT_CODE = 'AGENT_MAY_NOT_MANAGE_ACCOUNT';
export const ACCOUNT_SECURITY_NEEDS_SIGN_IN_CODE =
  'ACCOUNT_SECURITY_NEEDS_SIGN_IN';

const PASSWORD_THROTTLE = { default: { ttl: 60000, limit: 5 } };

/**
 * The caller's own account at the identity provider: name, password, second
 * factors and linked sign-ins. No route takes a user id; the account is always
 * the caller's, read from the credential. An agent credential is refused on
 * every route: the security of the account an agent acts for is never the
 * agent's to read or change. An API key may read the account and change its
 * name, but how the account signs in is changed only by the person, signed in.
 */
@ApiTags('account')
@ApiBearerAuth()
@Controller('account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get()
  @ApiOperation({ summary: 'Your profile and how your account signs in' })
  @ApiOkResponse({ type: AccountOverviewDto })
  overview(@Req() req: Request): Promise<AccountOverviewDto> {
    return this.account.overview(this.person(req));
  }

  @Put('profile')
  @ApiOperation({ summary: 'Change your first, last and display name' })
  @ApiBody({ type: UpdateAccountProfileDto })
  @ApiOkResponse({ type: AccountProfileDto })
  updateProfile(
    @Req() req: Request,
    @Body() dto: UpdateAccountProfileDto,
  ): Promise<AccountProfileDto> {
    return this.account.updateProfile(this.person(req), dto);
  }

  @Get('password-policy')
  @ApiOperation({ summary: 'What a new password must contain' })
  @ApiOkResponse({ type: PasswordPolicyDto })
  passwordPolicy(@Req() req: Request): Promise<PasswordPolicyDto> {
    return this.account.passwordPolicy(this.person(req));
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle(PASSWORD_THROTTLE)
  @ApiOperation({
    summary: 'Change your password, confirmed with the current one',
  })
  @ApiBody({ type: ChangeAccountPasswordDto })
  @ApiOkResponse({ type: AccountDoneDto })
  async changePassword(
    @Req() req: Request,
    @Body() dto: ChangeAccountPasswordDto,
  ): Promise<AccountDoneDto> {
    await this.account.changePassword(
      this.signedIn(req),
      dto.currentPassword,
      dto.newPassword,
    );
    return { success: true };
  }

  @Post('totp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle(PASSWORD_THROTTLE)
  @ApiOperation({
    summary:
      'Start setting up an authenticator app, confirmed with the current password; finish it with a code',
  })
  @ApiBody({ type: StartTotpDto })
  @ApiOkResponse({ type: TotpRegistrationDto })
  startTotp(
    @Req() req: Request,
    @Body() dto: StartTotpDto,
  ): Promise<TotpRegistrationDto> {
    return this.account.startTotp(this.signedIn(req), dto?.currentPassword);
  }

  @Post('totp/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle(PASSWORD_THROTTLE)
  @ApiOperation({ summary: 'Finish setting up the authenticator app' })
  @ApiBody({ type: VerifyTotpDto })
  @ApiOkResponse({ type: AccountDoneDto })
  async verifyTotp(
    @Req() req: Request,
    @Body() dto: VerifyTotpDto,
  ): Promise<AccountDoneDto> {
    await this.account.verifyTotp(this.signedIn(req), dto.code);
    return { success: true };
  }

  @Delete('totp')
  @UseGuards(ThrottlerGuard)
  @Throttle(PASSWORD_THROTTLE)
  @ApiOperation({ summary: 'Remove the authenticator app' })
  @ApiBody({ type: ConfirmWithPasswordDto })
  @ApiOkResponse({ type: AccountDoneDto })
  async removeTotp(
    @Req() req: Request,
    @Body() dto: ConfirmWithPasswordDto,
  ): Promise<AccountDoneDto> {
    await this.account.removeTotp(this.signedIn(req), dto.currentPassword);
    return { success: true };
  }

  @Delete('passkeys/:id')
  @UseGuards(ThrottlerGuard)
  @Throttle(PASSWORD_THROTTLE)
  @ApiOperation({ summary: 'Remove one of your passkeys' })
  @ApiBody({ type: ConfirmWithPasswordDto })
  @ApiOkResponse({ type: AccountDoneDto })
  async removePasskey(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: ConfirmWithPasswordDto,
  ): Promise<AccountDoneDto> {
    await this.account.removePasskey(
      this.signedIn(req),
      id,
      dto.currentPassword,
    );
    return { success: true };
  }

  @Delete('security-keys/:id')
  @UseGuards(ThrottlerGuard)
  @Throttle(PASSWORD_THROTTLE)
  @ApiOperation({ summary: 'Remove one of your security keys' })
  @ApiBody({ type: ConfirmWithPasswordDto })
  @ApiOkResponse({ type: AccountDoneDto })
  async removeSecurityKey(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: ConfirmWithPasswordDto,
  ): Promise<AccountDoneDto> {
    await this.account.removeSecurityKey(
      this.signedIn(req),
      id,
      dto.currentPassword,
    );
    return { success: true };
  }

  @Delete('links/:idpId/:externalUserId')
  @UseGuards(ThrottlerGuard)
  @Throttle(PASSWORD_THROTTLE)
  @ApiOperation({
    summary: 'Remove a GitHub or Google sign-in from your account',
  })
  @ApiBody({ type: ConfirmWithPasswordDto })
  @ApiOkResponse({ type: AccountDoneDto })
  async removeLink(
    @Req() req: Request,
    @Param('idpId') idpId: string,
    @Param('externalUserId') externalUserId: string,
    @Body() dto: ConfirmWithPasswordDto,
  ): Promise<AccountDoneDto> {
    await this.account.unlink(
      this.signedIn(req),
      { idpId, externalUserId },
      dto.currentPassword,
    );
    return { success: true };
  }

  private person(req: Request): AuthenticatedUser {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user) throw new ForbiddenException('Unauthenticated');
    const actor = actorFromRequest(req as Request & RequestWithApiKey);
    if (actor.kind === 'agent') {
      throw new ForbiddenException({
        statusCode: 403,
        code: AGENT_MAY_NOT_MANAGE_ACCOUNT_CODE,
        message:
          'An agent credential cannot read or change the account it acts for. Ask the person to do it themselves.',
      });
    }
    return user;
  }

  /** A person signed in through the browser; no key, however it was issued. */
  private signedIn(req: Request): AuthenticatedUser {
    const user = this.person(req);
    if (actorFromRequest(req as Request & RequestWithApiKey).kind !== 'user') {
      throw new ForbiddenException({
        statusCode: 403,
        code: ACCOUNT_SECURITY_NEEDS_SIGN_IN_CODE,
        message:
          'How your account signs in is changed from the Account page of the dashboard, signed in as yourself. An API key can read the account but not change its security.',
      });
    }
    return user;
  }
}
