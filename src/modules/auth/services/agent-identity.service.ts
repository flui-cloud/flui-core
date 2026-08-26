import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  OidcMachineUser,
  OidcProviderAdminClient,
} from '../../oidc/services/oidc-provider-admin.service';
import { UserEntity } from '../entities/user.entity';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import { IamPrincipal } from '../../iam/interfaces/iam.types';
import {
  GRANTABLE_SCOPES,
  SCOPE_REQUIRES_PERMISSION,
  isGrantableScope,
  orderScopes,
} from '../constants/api-key-scopes';
import { mcpScopesOf } from '../utils/credential-ceiling.util';
import {
  PROVIDER_ADMIN_CONTEXT,
  ProviderAdminContextSource,
} from '../interfaces/provider-admin-context';

/** What the caller gets back, once. The secret is never readable again. */
export interface AgentIdentity {
  userId: string;
  userName: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

const AGENT_USERNAME_PREFIX = 'flui-agent-';

/**
 * An agent's own identity in the provider, instead of a borrowed one.
 *
 * This is the half of decision 101 that the provider is genuinely better at
 * than Flui: a machine user is revocable centrally, its secret rotates in one
 * call, and the token it presents is verifiable without asking Flui anything.
 * What it is NOT is a second authorization system — the roles it is granted are
 * `mcp:*` project roles, which every gate in Flui already reads as a *ceiling*
 * on a credential and never as a grant.
 *
 * Two properties are load-bearing and both are enforced here rather than
 * described:
 *
 *   - **an identity is never worth more than whoever asked for it.** The same
 *     two ceilings the API-key path applies: the requester must hold the
 *     permission each scope `requires`, and a requester who is themselves
 *     holding a capped credential cannot mint an uncapped one. Refused whole,
 *     never trimmed — a credential that silently comes back smaller than asked
 *     for is one nobody can reason about;
 *   - **the identity carries no rung.** Only `mcp:*` roles are granted, never
 *     `viewer`/`operator`/`maintainer`/`owner`. A scope is a ceiling and can
 *     only take away; a rung is access and would hand an agent standing of its
 *     own. An agent acts for a person, so its permissions must come from that
 *     person's bindings and its scopes must only narrow them.
 */
@Injectable()
export class AgentIdentityService {
  private readonly logger = new Logger(AgentIdentityService.name);

  constructor(
    private readonly oidcProvider: OidcProviderAdminClient,
    @Inject(PROVIDER_ADMIN_CONTEXT)
    private readonly bootstrap: ProviderAdminContextSource,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  /**
   * Mints a machine user for `name`, grants it exactly `scopes`, and returns
   * its client credentials once.
   *
   * Deliberately not idempotent on the secret: calling it again for a name that
   * exists rotates the credential rather than handing back the old one, which
   * is the only thing the provider can do — it does not store the secret in a
   * readable form either.
   */
  async provision(
    issuer: IamPrincipal,
    name: string,
    scopes: string[],
  ): Promise<AgentIdentity> {
    const requested = this.grantableOrThrow(issuer, scopes);
    const ctx = await this.bootstrap.resolveProviderContext();
    if (!ctx) {
      throw new BadRequestException(
        'Agent identities require the bundled identity provider; this installation has none.',
      );
    }
    const { pat, providerDomain } = ctx;

    // The roles have to exist before they can be granted, and on an
    // installation bootstrapped by an older build some of them will not.
    await this.bootstrap.reconcileProjectRoles();
    const project = await this.oidcProvider.findProjectByName(
      pat,
      providerDomain,
      'Flui',
    );
    if (!project) {
      throw new BadRequestException('Flui project not found on the provider');
    }

    const userName = this.userNameFor(name);
    const existing = (
      await this.oidcProvider.listMachineUsers(pat, providerDomain)
    ).find((u) => u.userName === userName);

    const machine =
      existing ??
      (await this.oidcProvider.createMachineUser(pat, providerDomain, {
        userName,
        name,
        description: `Flui agent identity for "${name}"`,
      }));

    await this.oidcProvider.grantUserRole(
      pat,
      providerDomain,
      machine.id,
      project.id,
      requested,
    );
    const secret = await this.oidcProvider.generateMachineSecret(
      pat,
      providerDomain,
      machine.id,
    );
    this.logger.log(
      `Agent identity ${existing ? 'rotated' : 'created'}: ${userName} (${requested.length} scopes)`,
    );
    return {
      userId: machine.id,
      userName,
      clientId: secret.clientId,
      clientSecret: secret.clientSecret,
      scopes: requested,
    };
  }

  /** Removes the identity from the provider. Central revocation, in one call. */
  async revoke(userName: string): Promise<boolean> {
    const ctx = await this.bootstrap.resolveProviderContext();
    if (!ctx) return false;
    const { pat, providerDomain } = ctx;
    const match = (
      await this.oidcProvider.listMachineUsers(pat, providerDomain)
    ).find((u) => u.userName === this.userNameFor(userName));
    if (!match) return false;
    await this.oidcProvider.deleteUser(pat, providerDomain, match.id);
    return true;
  }

  /** Every agent identity Flui minted, by the prefix it mints them under. */
  async list(): Promise<OidcMachineUser[]> {
    const ctx = await this.bootstrap.resolveProviderContext();
    if (!ctx) return [];
    const users = await this.oidcProvider.listMachineUsers(
      ctx.pat,
      ctx.providerDomain,
    );
    return users.filter((u) => u.userName.startsWith(AGENT_USERNAME_PREFIX));
  }

  /**
   * The local account each of these provider identities acts as, keyed by the
   * provider's own user id.
   *
   * Two id spaces meet here and nothing else joined them. A machine identity is
   * listed by the provider's id; everything it then *does* is recorded against
   * a Flui `UserEntity` that `JwtStrategy` creates on the identity's first
   * token, linked only by `oidcSub`. Without this map the panel can list a
   * connected agent and can list what that agent did, and cannot put the two on
   * the same row — which is the whole of "who is connected, and when were they
   * last active".
   *
   * Absent rather than null-per-row when the identity has never authenticated:
   * there is no local account yet, and inventing one to have an id would create
   * an account for something that has never arrived.
   */
  async localAccountIds(
    providerUserIds: string[],
  ): Promise<Map<string, string>> {
    const subs = [...new Set(providerUserIds)].filter(Boolean);
    if (!subs.length) return new Map();
    const rows = await this.users.find({
      where: { oidcSub: In(subs) },
      select: ['id', 'oidcSub'],
    });
    return new Map(
      rows
        .filter((u): u is UserEntity & { oidcSub: string } => !!u.oidcSub)
        .map((u) => [u.oidcSub, u.id]),
    );
  }

  private userNameFor(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-/, '')
      .replace(/-$/, '')
      .slice(0, 40);
    if (!slug) throw new BadRequestException('Agent name is empty');
    return `${AGENT_USERNAME_PREFIX}${slug}`;
  }

  /**
   * The scopes this issuer may confer, or a refusal naming the ones they may
   * not. Synchronous on purpose: it takes a resolved access rather than
   * resolving one, so the caller decides when the DB is read.
   */
  private grantableOrThrow(
    issuer: IamPrincipal,
    requested: string[],
  ): string[] {
    if (!requested?.length) {
      throw new BadRequestException(
        'An agent identity must name the scopes it carries.',
      );
    }
    const unknown = requested.filter((s) => !isGrantableScope(s));
    if (unknown.length) {
      throw new BadRequestException(
        `Not scopes of this installation: ${unknown.join(', ')}`,
      );
    }
    // A capped credential cannot mint an uncapped one — the same rule the API
    // key path applies, read off the issuer's own scopes rather than a flag.
    const held = mcpScopesOf(issuer);
    if (held.length) {
      const beyond = requested.filter((s) => !held.includes(s));
      if (beyond.length) {
        throw new BadRequestException(
          `Your own credential does not carry: ${beyond.join(', ')}`,
        );
      }
    }
    return orderScopes(requested);
  }

  /**
   * The permission half of the ceiling, kept separate so the caller can resolve
   * access once and ask this against it. Returns the scopes the issuer may not
   * confer.
   */
  async beyondPermissions(
    issuer: IamPrincipal,
    requested: string[],
  ): Promise<string[]> {
    const access = await this.policy.resolveAccess(issuer);
    return requested.filter(
      (s) =>
        isGrantableScope(s) &&
        !this.policy.can(access, SCOPE_REQUIRES_PERMISSION[s]),
    );
  }

  /** The catalogue, for a caller that wants to offer a choice. */
  static get grantableScopes(): readonly string[] {
    return GRANTABLE_SCOPES;
  }
}
