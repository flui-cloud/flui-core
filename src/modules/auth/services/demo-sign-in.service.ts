import {
  BadGatewayException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { withAdvisoryLockWaiting } from '../../common/leadership/advisory-lock';
import { OidcProviderAdminClient } from '../../oidc/services/oidc-provider-admin.service';
import { describeError } from '../../shared/utils/error.util';
import {
  INTENT_CALLBACK_PATH,
  PROVIDERS,
  ProviderConnection,
  ProviderState,
  SIGN_IN_PROVIDER_KINDS,
  SignInProviderKind,
  SignInProviderRecord,
  SignInProvidersView,
  SignInProviderStatus,
  UpgradeProvider,
  blankStatus,
  callbackUrlOf,
  connectionFrom,
  currentIdpId,
  envCredentials,
  requireConnection,
  statusOf,
} from './demo-sign-in.core';

export { SIGN_IN_PROVIDER_KINDS } from './demo-sign-in.core';
export type {
  SignInProviderKind,
  SignInProviderSource,
  SignInProviderStatus,
  SignInProvidersView,
  UpgradeProvider,
} from './demo-sign-in.core';

const UPGRADE_PROVIDERS_TTL_MS = 60_000;
const RECORD_KEY_PREFIX = 'flui.sandbox.sign-in.';
const LOCK_NAME = 'demo-sign-in';

/**
 * On a demo instance anyone may sign in: with an email they register
 * themselves, or with GitHub or Google. Self-registration is applied on every
 * start, because the identity provider is configured once at install and a
 * demo is switched on later; idempotent, and never allowed to stop the API from
 * starting.
 *
 * GitHub and Google are connected by an administrator through
 * `PUT /sandbox/sign-in/providers/:provider`: the client secret goes to the
 * identity provider and nowhere else. The `SANDBOX_*_CLIENT_*` variables still
 * work for an installation that has not moved yet, with a warning on every
 * start, and are ignored once a provider has been connected or disconnected
 * through Flui.
 */
@Injectable()
export class DemoSignInService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DemoSignInService.name);
  private upgradeCache: { at: number; value: UpgradeProvider[] } | null = null;

  constructor(
    private readonly oidc: OidcProviderAdminClient,
    private readonly dataSource: DataSource,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.SANDBOX_ENABLED !== 'true') return;
    void this.apply().catch((error: unknown) =>
      this.logger.warn(`Could not open demo sign-in: ${describeError(error)}`),
    );
  }

  /**
   * Returns the providers it had to add from the environment, for the log and
   * the tests. Every copy of the API runs it at start, one after the other.
   */
  async apply(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    const conn = connectionFrom(env);
    if (!conn) {
      this.logger.warn(
        'Demo sign-in not configured: the identity provider is not reachable from here',
      );
      return [];
    }
    return this.serialised(() => this.applyWith(conn, env));
  }

  private async applyWith(
    conn: ProviderConnection,
    env: NodeJS.ProcessEnv,
  ): Promise<string[]> {
    const policy = await this.oidc.getLoginPolicy(conn.pat, conn.host);
    if (policy.isDefault || !policy.allowRegister || !policy.allowExternalIdp) {
      await this.oidc.openSelfRegistration(conn.pat, conn.host, policy);
    }

    const existing = await this.oidc.listIdentityProviders(conn.pat, conn.host);
    const state = { policy, existing };
    const added = await Promise.all(
      SIGN_IN_PROVIDER_KINDS.map((kind) =>
        this.applyOne(kind, conn, state, env),
      ),
    ).then((names) => names.filter((n): n is string => !!n));

    this.logger.log(
      `Demo sign-in open: self-registration on${
        added.length ? `, added ${added.join(' and ')}` : ''
      }`,
    );
    return added;
  }

  /** The provider's name when it had to be added from the environment. */
  private async applyOne(
    kind: SignInProviderKind,
    conn: ProviderConnection,
    state: ProviderState,
    env: NodeJS.ProcessEnv,
  ): Promise<string | null> {
    const spec = PROVIDERS[kind];
    const record = await this.readRecord(conn, kind);
    const fromEnv = envCredentials(env, kind);
    const linked = state.policy.idpIds;

    if (record) {
      if (fromEnv) {
        this.logger.warn(
          `${spec.envClientId} and ${spec.envClientSecret} are ignored: ${spec.name} sign-in is managed by Flui. Remove both from the configuration.`,
        );
      }
      const id = record.idpId;
      if (
        id &&
        !linked.includes(id) &&
        state.existing.some((p) => p.id === id)
      ) {
        await this.oidc.addIdentityProviderToLogin(conn.pat, conn.host, id);
      }
      return null;
    }

    if (!fromEnv) return null;
    this.logger.warn(
      `${spec.name} sign-in still comes from ${spec.envClientId} and ${spec.envClientSecret}, which keep its client secret in plain configuration. ` +
        `Move it with \`flui sandbox sign-in connect ${kind} --client-id <id>\`, then remove both variables.`,
    );
    let id = state.existing.find((p) => p.name === spec.name)?.id;
    let added: string | null = null;
    if (!id) {
      id = await this.oidc.addSocialIdentityProvider(
        conn.pat,
        conn.host,
        kind,
        {
          name: spec.name,
          ...fromEnv,
        },
      );
      added = spec.name;
    }
    if (!linked.includes(id)) {
      await this.oidc.addIdentityProviderToLogin(conn.pat, conn.host, id);
    }
    return added;
  }

  async list(
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<SignInProvidersView> {
    const demo = env.SANDBOX_ENABLED === 'true';
    const conn = connectionFrom(env);
    if (!conn) {
      return {
        demo,
        callbackUrl: null,
        intentCallbackUrl: null,
        providers: SIGN_IN_PROVIDER_KINDS.map((kind) => blankStatus(kind)),
      };
    }
    const state = await this.read(conn, 'read the sign-in providers');
    const records = await this.guard('read the sign-in providers', () =>
      Promise.all(
        SIGN_IN_PROVIDER_KINDS.map((kind) => this.readRecord(conn, kind)),
      ),
    );
    const providers = SIGN_IN_PROVIDER_KINDS.map((kind, i) =>
      statusOf(kind, records[i], state, env),
    );
    return {
      demo,
      callbackUrl: callbackUrlOf(conn),
      intentCallbackUrl: callbackUrlOf(conn, INTENT_CALLBACK_PATH),
      providers,
    };
  }

  /**
   * The GitHub and Google sign-ins a visitor may become an account with: those
   * connected and offered on the sign-in page. Remembered for a minute, since
   * every visitor's dialog asks.
   */
  async upgradeProviders(
    env: NodeJS.ProcessEnv = process.env,
    now = Date.now(),
  ): Promise<UpgradeProvider[]> {
    if (env.SANDBOX_ENABLED !== 'true') return [];
    const conn = connectionFrom(env);
    if (!conn) return [];
    const cached = this.upgradeCache;
    if (cached && now - cached.at < UPGRADE_PROVIDERS_TTL_MS) {
      return cached.value;
    }
    const state = await this.read(conn, 'read the sign-in providers');
    const records = await this.guard('read the sign-in providers', () =>
      Promise.all(
        SIGN_IN_PROVIDER_KINDS.map((kind) => this.readRecord(conn, kind)),
      ),
    );
    const value = SIGN_IN_PROVIDER_KINDS.flatMap((kind, i) => {
      const status = statusOf(kind, records[i], state, env);
      const idpId = currentIdpId(kind, records[i], state);
      return status.connected && status.onSignInPage && idpId
        ? [{ provider: kind, name: PROVIDERS[kind].name, idpId }]
        : [];
    });
    this.upgradeCache = { at: now, value };
    return value;
  }

  /**
   * Connect a provider, or give it new credentials. The secret is sent to the
   * identity provider and dropped: it is not stored, logged or returned here.
   */
  async connect(
    kind: SignInProviderKind,
    credentials: { clientId: string; clientSecret: string },
    actor: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<SignInProviderStatus> {
    if (env.SANDBOX_ENABLED !== 'true') {
      throw new ConflictException(
        'GitHub and Google sign-in is only offered on a demo installation: elsewhere it would let anyone with such an account register on the identity provider in front of the control plane.',
      );
    }
    const conn = requireConnection(env);
    return this.serialised(() =>
      this.connectWith(conn, kind, credentials, actor, env),
    );
  }

  private async connectWith(
    conn: ProviderConnection,
    kind: SignInProviderKind,
    credentials: { clientId: string; clientSecret: string },
    actor: string,
    env: NodeJS.ProcessEnv,
  ): Promise<SignInProviderStatus> {
    const spec = PROVIDERS[kind];
    const clientId = credentials.clientId.trim();
    const params = {
      name: spec.name,
      clientId,
      clientSecret: credentials.clientSecret,
    };

    const state = await this.read(conn, `connect ${spec.name}`);
    if (
      state.policy.isDefault ||
      !state.policy.allowRegister ||
      !state.policy.allowExternalIdp
    ) {
      await this.guard('open self-registration', () =>
        this.oidc.openSelfRegistration(conn.pat, conn.host, state.policy),
      );
    }
    const record = await this.guard(`connect ${spec.name}`, () =>
      this.readRecord(conn, kind),
    );
    let id = currentIdpId(kind, record, state);
    if (id) {
      const known = id;
      await this.guard(`update ${spec.name}`, () =>
        this.oidc.updateSocialIdentityProvider(
          conn.pat,
          conn.host,
          kind,
          known,
          params,
        ),
      );
    } else {
      id = await this.guard(`add ${spec.name}`, () =>
        this.oidc.addSocialIdentityProvider(conn.pat, conn.host, kind, params),
      );
    }
    if (!state.policy.idpIds.includes(id)) {
      const added = id;
      await this.guard(`show ${spec.name} on the sign-in page`, () =>
        this.oidc.addIdentityProviderToLogin(conn.pat, conn.host, added),
      );
    }

    const next: SignInProviderRecord = {
      clientId,
      idpId: id,
      connectedAt: new Date().toISOString(),
      connectedBy: actor,
      disconnectedAt: null,
    };
    await this.guard(`record ${spec.name}`, () =>
      this.writeRecord(conn, kind, next),
    );
    this.logger.log(
      `${spec.name} sign-in ${record?.idpId ? 'given new credentials' : 'connected'} by ${actor}`,
    );
    return statusOf(
      kind,
      next,
      {
        policy: { ...state.policy, idpIds: [...state.policy.idpIds, id] },
        existing: [...state.existing, { id, name: spec.name, type: kind }],
      },
      env,
    );
  }

  /**
   * Take a provider off the sign-in page and delete it, credentials included.
   * Remembered as disconnected, so the deprecated variables do not bring it
   * back on the next start.
   */
  async disconnect(
    kind: SignInProviderKind,
    actor: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<SignInProviderStatus> {
    const conn = requireConnection(env);
    return this.serialised(() => this.disconnectWith(conn, kind, actor, env));
  }

  private async disconnectWith(
    conn: ProviderConnection,
    kind: SignInProviderKind,
    actor: string,
    env: NodeJS.ProcessEnv,
  ): Promise<SignInProviderStatus> {
    const spec = PROVIDERS[kind];
    const state = await this.read(conn, `disconnect ${spec.name}`);
    const record = await this.guard(`disconnect ${spec.name}`, () =>
      this.readRecord(conn, kind),
    );
    const id = currentIdpId(kind, record, state);
    if (id) {
      if (state.policy.idpIds.includes(id)) {
        await this.guard(`take ${spec.name} off the sign-in page`, () =>
          this.oidc.removeIdentityProviderFromLogin(conn.pat, conn.host, id),
        );
      }
      await this.guard(`delete ${spec.name}`, () =>
        this.oidc.deleteIdentityProvider(conn.pat, conn.host, id),
      );
    }

    const next: SignInProviderRecord = {
      clientId: null,
      idpId: null,
      connectedAt: null,
      connectedBy: null,
      disconnectedAt: new Date().toISOString(),
    };
    await this.guard(`record ${spec.name}`, () =>
      this.writeRecord(conn, kind, next),
    );
    this.logger.log(`${spec.name} sign-in disconnected by ${actor}`);
    return statusOf(
      kind,
      next,
      {
        policy: {
          ...state.policy,
          idpIds: state.policy.idpIds.filter((p) => p !== id),
        },
        existing: state.existing.filter((p) => p.id !== id),
      },
      env,
    );
  }

  /**
   * One change to the identity provider at a time across every copy of the
   * API: two copies starting together would otherwise each add GitHub.
   */
  private serialised<T>(work: () => Promise<T>): Promise<T> {
    this.upgradeCache = null;
    return withAdvisoryLockWaiting(this.dataSource, LOCK_NAME, work);
  }

  private async read(
    conn: ProviderConnection,
    what: string,
  ): Promise<ProviderState> {
    return this.guard(what, async () => ({
      policy: await this.oidc.getLoginPolicy(conn.pat, conn.host),
      existing: await this.oidc.listIdentityProviders(conn.pat, conn.host),
    }));
  }

  private async readRecord(
    conn: ProviderConnection,
    kind: SignInProviderKind,
  ): Promise<SignInProviderRecord | null> {
    const raw = await this.oidc.findOrgMetadata(
      conn.pat,
      conn.host,
      RECORD_KEY_PREFIX + kind,
    );
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<SignInProviderRecord>;
      return {
        clientId: parsed.clientId ?? null,
        idpId: parsed.idpId ?? null,
        connectedAt: parsed.connectedAt ?? null,
        connectedBy: parsed.connectedBy ?? null,
        disconnectedAt: parsed.disconnectedAt ?? null,
      };
    } catch {
      return null;
    }
  }

  private async writeRecord(
    conn: ProviderConnection,
    kind: SignInProviderKind,
    record: SignInProviderRecord,
  ): Promise<void> {
    await this.oidc.setOrgMetadata(
      conn.pat,
      conn.host,
      RECORD_KEY_PREFIX + kind,
      JSON.stringify(record),
    );
  }

  /** Only the provider's answer is reported, never the request that carried the secret. */
  private async guard<T>(what: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new BadGatewayException(
        `The identity provider could not ${what}: ${describeError(error)}`,
      );
    }
  }
}
