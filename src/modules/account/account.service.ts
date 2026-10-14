import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { USER_KIND, UserEntity } from '../auth/entities/user.entity';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../iam/interfaces/policy-engine.interface';
import { principalFromUser } from '../iam/interfaces/iam.types';
import {
  AccountUser,
  OidcAccountClient,
} from '../oidc/services/oidc-account.client';
import { statusOf } from '../oidc/services/oidc-visitor-login.client';
import {
  ProviderConnection,
  serviceConnection,
} from '../sandbox/visitors/provider-connection';
import { passwordRequirements, unmetRequirements } from './password-rules';
import {
  AccountLinkDto,
  AccountOverviewDto,
  PasswordPolicyDto,
  TotpRegistrationDto,
  UpdateAccountProfileDto,
} from './dto/account.dto';

export const ACCOUNT_CODES = {
  VISITOR: 'ACCOUNT_NOT_FOR_VISITORS',
  LOCAL_MODE: 'ACCOUNT_LOCAL_MODE',
  NOT_LINKED: 'ACCOUNT_NOT_LINKED',
  PROVIDER_UNAVAILABLE: 'IDENTITY_PROVIDER_UNAVAILABLE',
  PROVIDER_ERROR: 'IDENTITY_PROVIDER_ERROR',
  CURRENT_PASSWORD_INVALID: 'CURRENT_PASSWORD_INVALID',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  PASSWORD_POLICY: 'PASSWORD_POLICY',
  NO_PASSWORD: 'ACCOUNT_HAS_NO_PASSWORD',
  TOTP_CODE_INVALID: 'TOTP_CODE_INVALID',
  TOTP_ALREADY_SET: 'TOTP_ALREADY_SET',
  GUEST_KEEPS_SIGN_IN: 'GUEST_KEEPS_SIGN_IN',
  LAST_SIGN_IN_METHOD: 'LAST_SIGN_IN_METHOD',
} as const;

/** Whose account a request may act on, decided from the credential and nothing else. */
export interface AccountOwner {
  sub: string;
  guest: boolean;
  conn: ProviderConnection;
}

/**
 * A person's own account at the identity provider, run by Flui so the provider's
 * console never has to be opened to anybody.
 *
 * The provider user id is always read from the caller's own row: no route takes
 * one, so no request can name somebody else's account. A visitor of the demo has
 * no account to manage and is refused outright; a guest manages its own security
 * but keeps the sign-in it entered the demo with, which Flui's upgrade and
 * merge logic is built around.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly client: OidcAccountClient,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  async owner(user: AuthenticatedUser): Promise<AccountOwner> {
    if ((process.env.AUTH_MODE ?? '').toLowerCase() === 'local') {
      throw new NotImplementedException({
        code: ACCOUNT_CODES.LOCAL_MODE,
        message:
          'This installation signs in with local accounts. Use the profile and password settings instead.',
      });
    }
    const row = await this.users.findOne({ where: { id: user.userId } });
    if (row?.kind === USER_KIND.VISITOR) throw visitorRefusal();
    if (!row?.oidcSub) {
      throw new NotFoundException({
        code: ACCOUNT_CODES.NOT_LINKED,
        message: 'This sign-in has no account at the identity provider.',
      });
    }
    const access = await this.policy.resolveAccess({
      ...principalFromUser(user),
      isAdmin: false,
    });
    if (access.isVisitor) throw visitorRefusal();
    const conn = serviceConnection();
    if (!conn) {
      throw new ServiceUnavailableException({
        code: ACCOUNT_CODES.PROVIDER_UNAVAILABLE,
        message: 'The identity provider cannot be reached from Flui right now.',
      });
    }
    return { sub: row.oidcSub, guest: access.isSandbox === true, conn };
  }

  async overview(user: AuthenticatedUser): Promise<AccountOverviewDto> {
    const o = await this.owner(user);
    const { pat, host } = o.conn;
    return this.provider('read your account', async () => {
      const [profile, methods, passkeys, factors, links] = await Promise.all([
        this.client.getUser(pat, host, o.sub),
        this.client.authMethods(pat, host, o.sub),
        this.client.listPasskeys(pat, host, o.sub),
        this.client.secondFactors(pat, host, o.sub),
        this.namedLinks(o),
      ]);
      return {
        profile: {
          userName: profile.userName,
          email: profile.email,
          emailVerified: profile.emailVerified,
          firstName: profile.givenName,
          lastName: profile.familyName,
          displayName: profile.displayName,
        },
        security: {
          password: methods.includes('PASSWORD'),
          totp: factors.totp || methods.includes('TOTP'),
          passkeys,
          securityKeys: factors.securityKeys,
          links,
        },
        limits: { guest: o.guest, canUnlink: !o.guest },
      };
    });
  }

  async updateProfile(
    user: AuthenticatedUser,
    dto: UpdateAccountProfileDto,
  ): Promise<AccountOverviewDto['profile']> {
    const o = await this.owner(user);
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    const displayName = dto.displayName?.trim() || `${firstName} ${lastName}`;
    if (!firstName || !lastName) {
      throw new BadRequestException('First and last name cannot be blank.');
    }
    const { pat, host } = o.conn;
    const profile = await this.provider('change your name', async () => {
      await this.client.updateProfile(pat, host, o.sub, {
        givenName: firstName,
        familyName: lastName,
        displayName,
      });
      return this.client.getUser(pat, host, o.sub);
    });
    await this.users.update(
      { id: user.userId },
      {
        firstName: profile.givenName ?? firstName,
        lastName: profile.familyName ?? lastName,
        displayName: profile.displayName ?? displayName,
        name: profile.displayName ?? displayName,
        profileSyncedAt: new Date(),
      },
    );
    return {
      userName: profile.userName,
      email: profile.email,
      emailVerified: profile.emailVerified,
      firstName: profile.givenName,
      lastName: profile.familyName,
      displayName: profile.displayName,
    };
  }

  async passwordPolicy(user: AuthenticatedUser): Promise<PasswordPolicyDto> {
    const o = await this.owner(user);
    const policy = await this.provider('read the password rules', async () =>
      this.client.passwordComplexity(
        o.conn.pat,
        o.conn.host,
        (await this.profileOf(o)).orgId,
      ),
    );
    return {
      minLength: policy.minLength,
      requirements: passwordRequirements(policy),
    };
  }

  async changePassword(
    user: AuthenticatedUser,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const o = await this.owner(user);
    const { pat, host } = o.conn;
    const policy = await this.provider('read the password rules', async () =>
      this.client.passwordComplexity(
        pat,
        host,
        (await this.profileOf(o)).orgId,
      ),
    );
    const unmet = unmetRequirements(newPassword, policy);
    if (unmet.length) throw policyRefusal(unmet.map((r) => r.label));
    await this.confirmPassword(o, currentPassword);
    try {
      await this.client.setPassword(
        pat,
        host,
        o.sub,
        currentPassword,
        newPassword,
      );
    } catch (error) {
      if (statusOf(error) === 400) {
        this.logger.warn(
          `Identity provider refused the new password: ${providerMessage(error)}`,
        );
        throw policyRefusal(
          passwordRequirements(policy).map((r) => r.label),
          true,
        );
      }
      throw this.translate(error, 'change your password');
    }
  }

  /** Confirmed with the current password when the account has one, like removing it. */
  async startTotp(
    user: AuthenticatedUser,
    currentPassword?: string,
  ): Promise<TotpRegistrationDto> {
    const o = await this.owner(user);
    const methods = await this.provider('read your sign-in methods', () =>
      this.client.authMethods(o.conn.pat, o.conn.host, o.sub),
    );
    if (methods.includes('PASSWORD')) {
      await this.confirmPassword(o, currentPassword ?? '', methods);
    }
    try {
      return await this.client.registerTotp(o.conn.pat, o.conn.host, o.sub);
    } catch (error) {
      const status = statusOf(error);
      if (status === 409 || status === 412) {
        throw new ConflictException({
          code: ACCOUNT_CODES.TOTP_ALREADY_SET,
          message:
            'An authenticator app is already set up. Remove it first to set up another.',
        });
      }
      throw this.translate(error, 'set up an authenticator app');
    }
  }

  async verifyTotp(user: AuthenticatedUser, code: string): Promise<void> {
    const o = await this.owner(user);
    try {
      await this.client.verifyTotp(o.conn.pat, o.conn.host, o.sub, code);
    } catch (error) {
      const status = statusOf(error);
      if (status === 400 || status === 412) {
        throw new BadRequestException({
          code: ACCOUNT_CODES.TOTP_CODE_INVALID,
          message:
            'That code was not accepted. Check the time on your phone and try the next one.',
        });
      }
      throw this.translate(error, 'confirm the authenticator app');
    }
  }

  async removeTotp(user: AuthenticatedUser, currentPassword: string) {
    const o = await this.owner(user);
    await this.confirmPassword(o, currentPassword);
    await this.provider('remove the authenticator app', () =>
      this.client.removeTotp(o.conn.pat, o.conn.host, o.sub),
    );
  }

  async removePasskey(
    user: AuthenticatedUser,
    passkeyId: string,
    currentPassword: string,
  ): Promise<void> {
    const o = await this.owner(user);
    const { pat, host } = o.conn;
    const keys = await this.provider('read your passkeys', () =>
      this.client.listPasskeys(pat, host, o.sub),
    );
    if (!keys.some((k) => k.id === passkeyId)) throw notYours('passkey');
    await this.confirmPassword(o, currentPassword);
    await this.provider('remove the passkey', () =>
      this.client.removePasskey(pat, host, o.sub, passkeyId),
    );
  }

  async removeSecurityKey(
    user: AuthenticatedUser,
    keyId: string,
    currentPassword: string,
  ): Promise<void> {
    const o = await this.owner(user);
    const { pat, host } = o.conn;
    const factors = await this.provider('read your security keys', () =>
      this.client.secondFactors(pat, host, o.sub),
    );
    if (!factors.securityKeys.some((k) => k.id === keyId)) {
      throw notYours('security key');
    }
    await this.confirmPassword(o, currentPassword);
    await this.provider('remove the security key', () =>
      this.client.removeSecurityKey(pat, host, o.sub, keyId),
    );
  }

  async unlink(
    user: AuthenticatedUser,
    link: { idpId: string; externalUserId: string },
    currentPassword: string,
  ): Promise<void> {
    const o = await this.owner(user);
    if (o.guest) {
      throw new ForbiddenException({
        code: ACCOUNT_CODES.GUEST_KEEPS_SIGN_IN,
        message:
          'During the trial your account keeps the sign-in you entered with.',
      });
    }
    const { pat, host } = o.conn;
    const [links, methods, passkeys] = await this.provider(
      'read your sign-ins',
      () =>
        Promise.all([
          this.client.listIdpLinks(pat, host, o.sub),
          this.client.authMethods(pat, host, o.sub),
          this.client.listPasskeys(pat, host, o.sub),
        ]),
    );
    const target = links.find(
      (l) => l.idpId === link.idpId && l.externalUserId === link.externalUserId,
    );
    if (!target) throw notYours('linked sign-in');
    const otherWayIn =
      methods.includes('PASSWORD') ||
      passkeys.some((p) => p.ready) ||
      links.length > 1;
    if (!otherWayIn) {
      throw new ConflictException({
        code: ACCOUNT_CODES.LAST_SIGN_IN_METHOD,
        message:
          'This is the only way you sign in. Add another one before removing it.',
      });
    }
    await this.confirmPassword(o, currentPassword, methods);
    await this.provider('remove the linked sign-in', () =>
      this.client.removeIdpLink(pat, host, o.sub, target),
    );
  }

  private async profileOf(o: AccountOwner): Promise<AccountUser> {
    return this.client.getUser(o.conn.pat, o.conn.host, o.sub);
  }

  private async namedLinks(o: AccountOwner): Promise<AccountLinkDto[]> {
    const links = await this.client.listIdpLinks(
      o.conn.pat,
      o.conn.host,
      o.sub,
    );
    const names = new Map<string, string | null>();
    for (const id of new Set(links.map((l) => l.idpId))) {
      names.set(id, await this.client.idpName(o.conn.pat, o.conn.host, id));
    }
    return links.map((l) => ({
      ...l,
      provider: names.get(l.idpId) ?? 'Sign-in provider',
    }));
  }

  /** The current password, checked before anything sensitive changes. */
  private async confirmPassword(
    o: AccountOwner,
    password: string,
    knownMethods?: string[],
  ): Promise<void> {
    const methods =
      knownMethods ??
      (await this.provider('read your sign-in methods', () =>
        this.client.authMethods(o.conn.pat, o.conn.host, o.sub),
      ));
    if (!methods.includes('PASSWORD')) {
      throw new ForbiddenException({
        code: ACCOUNT_CODES.NO_PASSWORD,
        message:
          'This change is confirmed with your password, and your account signs in without one.',
      });
    }
    const check = password
      ? await this.provider('check your password', () =>
          this.client.checkPassword(o.conn.pat, o.conn.host, o.sub, password),
        )
      : 'invalid';
    if (check === 'locked') {
      throw new ForbiddenException({
        code: ACCOUNT_CODES.ACCOUNT_LOCKED,
        message:
          'Your account is locked or deactivated at the identity provider. Ask an administrator to unlock it.',
      });
    }
    if (check !== 'valid') {
      throw new BadRequestException({
        code: ACCOUNT_CODES.CURRENT_PASSWORD_INVALID,
        message: 'Your current password is not correct.',
      });
    }
  }

  private async provider<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw this.translate(error, what);
    }
  }

  private translate(error: unknown, what: string): Error {
    if (error instanceof HttpException) return error;
    const status = statusOf(error);
    if (status === 404) return notYours('item');
    this.logger.warn(
      `Identity provider refused to ${what}: ${status ?? ''} ${providerMessage(error)}`,
    );
    return new BadGatewayException({
      code: ACCOUNT_CODES.PROVIDER_ERROR,
      message: `The identity provider could not ${what}. Try again in a moment.`,
    });
  }
}

function visitorRefusal(): ForbiddenException {
  return new ForbiddenException({
    code: ACCOUNT_CODES.VISITOR,
    message: 'Sign in to have an account of your own.',
  });
}

function notYours(what: string): NotFoundException {
  return new NotFoundException(`No such ${what} on your account.`);
}

function policyRefusal(
  requirements: string[],
  refusedByProvider = false,
): BadRequestException {
  const list = requirements.join(', ').toLowerCase();
  const detail = list ? ` (${list})` : '';
  return new BadRequestException({
    code: ACCOUNT_CODES.PASSWORD_POLICY,
    message: refusedByProvider
      ? `The new password does not meet the password rules${detail}.`
      : `The new password is missing: ${list}.`,
    unmet: refusedByProvider ? [] : requirements,
  });
}

function providerMessage(error: unknown): string {
  const data = (error as { response?: { data?: { message?: unknown } } })
    ?.response?.data;
  return typeof data?.message === 'string'
    ? data.message
    : ((error as Error)?.message ?? 'unknown error');
}
