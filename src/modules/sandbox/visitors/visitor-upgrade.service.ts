import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { USER_KIND, UserEntity } from '../../auth/entities/user.entity';
import {
  DemoSignInService,
  SignInProviderKind,
} from '../../auth/services/demo-sign-in.service';
import {
  IdpIntentResult,
  OidcVisitorUpgradeClient,
} from '../../oidc/services/oidc-visitor-upgrade.client';
import { statusOf } from '../../oidc/services/oidc-visitor-login.client';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { describeError } from '../../shared/utils/error.util';
import {
  SandboxVisitorUpgradeEntity,
  VISITOR_UPGRADE_METHOD,
} from '../entities/sandbox-visitor-upgrade.entity';
import { ProviderConnection, serviceConnection } from './provider-connection';
import { VisitorLoginClientService } from './visitor-login-client.service';
import {
  OUTCOME,
  VISITOR_FLOW_TTL_MS,
  VisitorLinkService,
  hashSecret,
  newSecret,
} from './visitor-link.service';
import { VisitorMergeService, VisitorMergeVia } from './visitor-merge.service';
import {
  VISITOR_CONFIG,
  VISITOR_LOGIN_PATH,
  VisitorConfig,
} from './visitor.config';
import { dashboardUrl } from './visitor-return';

export interface UpgradeFinish {
  outcome: 'upgraded' | 'signin-as-existing' | 'refused';
  reason: string | null;
  returnTo: string | null;
  linkNonce: string | null;
}

export interface UpgradeCallback {
  result: string | undefined;
  id: string | undefined;
  token: string | undefined;
}

const CALLBACK_PATH = `${VISITOR_LOGIN_PATH}/upgrade/callback`;

/**
 * GitHub or Google on the visitor's own identity-provider user. The browser
 * that started it must finish it: the provider sends it back to Flui, Flui
 * hands the dashboard a single-use handle, and only the same visitor's session
 * can spend that handle. So a sign-in link sent to somebody else cannot attach
 * their GitHub to the sender's visit.
 */
@Injectable()
export class VisitorUpgradeService {
  private readonly logger = new Logger(VisitorUpgradeService.name);

  constructor(
    @Inject(VISITOR_CONFIG) private readonly config: VisitorConfig,
    @InjectRepository(SandboxVisitorUpgradeEntity)
    private readonly upgrades: Repository<SandboxVisitorUpgradeEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly signIn: DemoSignInService,
    private readonly provider: OidcVisitorUpgradeClient,
    private readonly loginClient: VisitorLoginClientService,
    private readonly encryption: EncryptionService,
    private readonly links: VisitorLinkService,
    private readonly merge: VisitorMergeService,
  ) {}

  async providers(): Promise<{
    providers: Array<{ provider: SignInProviderKind; name: string }>;
    email: boolean;
  }> {
    const offered = await this.signIn.upgradeProviders().catch((error) => {
      this.logger.warn(`Sign-in providers unknown: ${describeError(error)}`);
      return [];
    });
    return {
      providers: offered.map(({ provider, name }) => ({ provider, name })),
      email: this.config.sandboxEnabled,
    };
  }

  async start(
    visitorUserId: string,
    kind: SignInProviderKind,
    returnTo: string | null,
    now = new Date(),
  ): Promise<{ authUrl: string }> {
    await this.links.visitorOrRefuse(visitorUserId);
    const offered = await this.signIn.upgradeProviders();
    const idp = offered.find((p) => p.provider === kind);
    if (!idp) {
      throw new NotFoundException(
        `Signing in with ${kind} is not offered here.`,
      );
    }
    const conn = this.connection();
    const callback = `${this.config.apiBase}${CALLBACK_PATH}`;
    const started = await this.withLoginClientFallback(conn, (pat) =>
      this.provider.startIntent(pat, conn.host, {
        idpId: idp.idpId,
        successUrl: `${callback}?result=success`,
        failureUrl: `${callback}?result=failure`,
      }),
    );
    if (!started.intentId) {
      throw new ServiceUnavailableException(
        'The identity provider did not say which sign-in it started.',
      );
    }
    await this.upgrades.save(
      this.upgrades.create({
        visitorUserId,
        method: VISITOR_UPGRADE_METHOD.IDP,
        provider: kind,
        idpId: idp.idpId,
        intentId: started.intentId,
        returnTo,
        expiresAt: new Date(now.getTime() + VISITOR_FLOW_TTL_MS),
      }),
    );
    return { authUrl: started.authUrl };
  }

  /** Where the browser goes after the provider: never an address from the request. */
  async callback(q: UpgradeCallback, now = new Date()): Promise<string> {
    const failed = (returnTo: string | null) =>
      dashboardUrl(this.config, returnTo, { visitor: 'upgrade-failed' });
    const row = q.id
      ? await this.upgrades.findOne({
          where: { intentId: q.id, method: VISITOR_UPGRADE_METHOD.IDP },
        })
      : null;
    if (!row) return failed(null);
    if (
      q.result !== 'success' ||
      !q.token ||
      row.secretHash ||
      row.claimedAt ||
      row.expiresAt.getTime() <= now.getTime()
    ) {
      return failed(row.returnTo);
    }
    const flow = newSecret();
    const stored = await this.upgrades.update(
      { id: row.id, secretHash: IsNull() },
      {
        secretHash: hashSecret(flow),
        intentTokenEncrypted: this.encryption.encrypt(q.token),
      },
    );
    if (!stored.affected) return failed(row.returnTo);
    return dashboardUrl(this.config, row.returnTo, { visitor: 'finish', flow });
  }

  async finish(
    callerUserId: string,
    flow: string,
    now = new Date(),
  ): Promise<UpgradeFinish> {
    const row = await this.upgrades.findOne({
      where: {
        secretHash: hashSecret(flow),
        method: VISITOR_UPGRADE_METHOD.IDP,
      },
    });
    if (row?.visitorUserId !== callerUserId) {
      throw new NotFoundException('This sign-in is not known.');
    }
    if (row.outcome) return this.replay(row, now);
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw new GoneException('This sign-in has expired.');
    }
    const claimed = await this.upgrades.update(
      { id: row.id, claimedAt: IsNull() },
      { claimedAt: now },
    );
    if (!claimed.affected) {
      throw new ConflictException('This sign-in is already being finished.');
    }

    let result: UpgradeFinish;
    try {
      result = await this.complete(row, now);
    } catch (error) {
      await this.upgrades.update({ id: row.id }, { claimedAt: null });
      this.logger.warn(
        `Visitor ${row.visitorUserId} could not finish signing in with ${row.provider}: ${describeError(error)}`,
      );
      return this.answer(row, OUTCOME.REFUSED, 'failed', null);
    }
    await this.upgrades.update(
      { id: row.id },
      {
        outcome: result.reason
          ? `${result.outcome}:${result.reason}`
          : result.outcome,
      },
    );
    return result;
  }

  private async complete(
    row: SandboxVisitorUpgradeEntity,
    now: Date,
  ): Promise<UpgradeFinish> {
    const visitor = await this.users.findOne({
      where: { id: row.visitorUserId },
    });
    if (!visitor) return this.answer(row, OUTCOME.REFUSED, 'expired', null);
    if (visitor.kind !== USER_KIND.VISITOR) {
      return this.answer(row, OUTCOME.UPGRADED, null, null);
    }
    if (visitor.blockedAt) {
      return this.answer(row, OUTCOME.REFUSED, 'blocked', null);
    }
    const conn = this.connection();
    const token = this.encryption.decrypt(row.intentTokenEncrypted ?? '');
    const info = await this.withLoginClientFallback(conn, (pat) =>
      this.provider.retrieveIntent(pat, conn.host, row.intentId ?? '', token),
    );
    if (!info.idpId || info.idpId !== row.idpId || !info.externalUserId) {
      return this.answer(row, OUTCOME.REFUSED, 'failed', null);
    }
    const via = row.provider === 'google' ? 'google' : 'github';

    const linkedTo =
      info.linkedUserId && info.linkedUserId !== visitor.oidcSub
        ? info.linkedUserId
        : null;
    if (linkedTo) return this.foldIntoOwner(row, visitor, linkedTo, via, now);

    const email = info.emailVerified ? info.email : null;
    if (await this.heldByAnother(email, visitor)) {
      return this.proveAccount(row, now);
    }
    return this.attachToVisitor(row, conn, visitor, info, email, via, now);
  }

  private async foldIntoOwner(
    row: SandboxVisitorUpgradeEntity,
    visitor: UserEntity,
    linkedTo: string,
    via: VisitorMergeVia,
    now: Date,
  ): Promise<UpgradeFinish> {
    const owner = await this.users.findOne({ where: { oidcSub: linkedTo } });
    if (owner?.kind === USER_KIND.VISITOR) {
      return this.answer(row, OUTCOME.REFUSED, 'failed', null);
    }
    if (!owner) return this.proveAccount(row, now);
    const folded = await this.merge.fold(visitor.id, owner, via, now);
    return folded.done
      ? this.answer(row, OUTCOME.SIGN_IN_AS_EXISTING, null, null)
      : this.answer(row, OUTCOME.REFUSED, refusalOf(folded.reason), null);
  }

  private async heldByAnother(
    email: string | null,
    visitor: UserEntity,
  ): Promise<boolean> {
    if (!email) return false;
    const holder = await this.users.findOne({ where: { email } });
    return !!holder && holder.id !== visitor.id;
  }

  private async attachToVisitor(
    row: SandboxVisitorUpgradeEntity,
    conn: ProviderConnection,
    visitor: UserEntity,
    info: IdpIntentResult,
    email: string | null,
    via: VisitorMergeVia,
    now: Date,
  ): Promise<UpgradeFinish> {
    const visitorIdp = visitor.oidcSub ?? '';
    const linkedHere = info.linkedUserId === visitor.oidcSub;
    if (!linkedHere) {
      await this.provider.addIdpLink(conn.pat, conn.host, visitorIdp, info);
    }
    let flipped;
    try {
      flipped = await this.merge.flip(
        visitor.id,
        profileChange(info, email),
        via,
        now,
      );
    } catch (error) {
      if (!linkedHere) await this.unlink(conn, visitorIdp, info);
      throw error;
    }
    if (!flipped.done) {
      if (!linkedHere) await this.unlink(conn, visitorIdp, info);
      return this.answer(row, OUTCOME.REFUSED, refusalOf(flipped.reason), null);
    }
    await this.updateProvider(conn, visitorIdp, visitor, info);
    return this.answer(row, OUTCOME.UPGRADED, null, null);
  }

  /**
   * The same answer again; a link to an account is single-use and only its
   * hash is kept, so a visitor still waiting for one is given a fresh one.
   */
  private async replay(
    row: SandboxVisitorUpgradeEntity,
    now: Date,
  ): Promise<UpgradeFinish> {
    const answer = this.answer(row, row.outcome ?? '', null, null);
    if (answer.outcome !== OUTCOME.SIGN_IN_AS_EXISTING) return answer;
    const visitor = await this.users.findOne({
      where: { id: row.visitorUserId },
    });
    if (visitor?.kind !== USER_KIND.VISITOR || visitor.blockedAt) return answer;
    const intent = await this.links.createIntent(
      row.visitorUserId,
      row.returnTo,
      now,
    );
    return { ...answer, linkNonce: intent.nonce };
  }

  /** The identity belongs to an account Flui has not met, or the address does: that account signs in and takes the visit by email link. */
  private async proveAccount(
    row: SandboxVisitorUpgradeEntity,
    now: Date,
  ): Promise<UpgradeFinish> {
    const intent = await this.links.createIntent(
      row.visitorUserId,
      row.returnTo,
      now,
    );
    return this.answer(row, OUTCOME.SIGN_IN_AS_EXISTING, null, intent.nonce);
  }

  /** After the flip is committed: the provider is brought in line, a failure only logged. */
  private async updateProvider(
    conn: ProviderConnection,
    idpUserId: string,
    visitor: UserEntity,
    info: IdpIntentResult,
  ): Promise<void> {
    const steps: Array<[string, () => Promise<void>]> = [
      [
        'profile',
        () =>
          this.provider.setProfile(conn.pat, conn.host, idpUserId, {
            givenName: info.givenName ?? info.externalUserName ?? 'Flui',
            familyName: info.familyName ?? info.givenName ?? 'User',
            displayName:
              info.displayName ??
              ([info.givenName, info.familyName].filter(Boolean).join(' ') ||
                info.externalUserName),
          }),
      ],
      [
        'visitor mark',
        () => this.provider.clearVisitorMark(conn.pat, conn.host, idpUserId),
      ],
    ];
    if (info.email) {
      steps.unshift([
        'email',
        () =>
          this.provider.setEmail(
            conn.pat,
            conn.host,
            idpUserId,
            info.email ?? '',
            info.emailVerified,
          ),
      ]);
    }
    for (const [what, step] of steps) {
      await step().catch((error: unknown) =>
        this.logger.warn(
          `Visitor ${visitor.id} is an account now, but its ${what} was not updated at the identity provider: ${describeError(error)}`,
        ),
      );
    }
  }

  private async unlink(
    conn: ProviderConnection,
    idpUserId: string,
    info: IdpIntentResult,
  ): Promise<void> {
    await this.provider
      .removeIdpLink(conn.pat, conn.host, idpUserId, info)
      .catch((error: unknown) =>
        this.logger.error(
          `Link of ${info.idpId} left on visitor ${idpUserId} after a failed upgrade: ${describeError(error)}`,
        ),
      );
  }

  private connection(): ProviderConnection {
    const conn = serviceConnection();
    if (!conn) {
      throw new ServiceUnavailableException(
        'The identity provider is not reachable from this API.',
      );
    }
    return conn;
  }

  /** Flui's own account first; the login-client one when the provider wants a login client. */
  private async withLoginClientFallback<T>(
    conn: ProviderConnection,
    call: (pat: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await call(conn.pat);
    } catch (error) {
      if (statusOf(error) !== 403) throw error;
      const pat = await this.loginClient.token();
      if (!pat) throw error;
      return call(pat);
    }
  }

  private answer(
    row: SandboxVisitorUpgradeEntity,
    stored: string,
    reason: string | null,
    linkNonce: string | null,
  ): UpgradeFinish {
    const [outcome, storedReason] = stored.split(':') as [
      UpgradeFinish['outcome'],
      string | undefined,
    ];
    return {
      outcome,
      reason: reason ?? storedReason ?? null,
      returnTo: row.returnTo,
      linkNonce,
    };
  }
}

function refusalOf(reason: 'gone' | 'blocked' | undefined): string {
  return reason === 'blocked' ? 'blocked' : 'expired';
}

function profileChange(info: IdpIntentResult, email: string | null) {
  const displayName =
    info.displayName ??
    ([info.givenName, info.familyName].filter(Boolean).join(' ') ||
      info.externalUserName ||
      null);
  return {
    email,
    firstName: info.givenName,
    lastName: info.familyName,
    displayName,
  };
}
