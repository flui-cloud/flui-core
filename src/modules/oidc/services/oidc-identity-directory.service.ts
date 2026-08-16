import {
  BadGatewayException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { IdentityRole, UserEntity } from '../../auth/entities/user.entity';
import {
  CreateIdentityUserInput,
  CreatedIdentityUser,
  IIdentityDirectory,
  IdentityUser,
  InviteLink,
  ListIdentityUsersQuery,
} from '../../auth/interfaces/identity-directory.interface';
import {
  ClusterEntity,
  ClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { OidcProviderAdminClient } from './oidc-provider-admin.service';
import { buildSystemNipHostname } from '../../dns/utils/nip-hostname.util';

const FLUI_PROJECT_NAME = 'Flui';
const FLUI_ADMIN_USERNAME_PREFIX = 'flui-admin';

@Injectable()
export class OidcIdentityDirectory implements IIdentityDirectory {
  private readonly logger = new Logger(OidcIdentityDirectory.name);
  private cachedProjectId: string | null = null;

  constructor(
    private readonly oidcProvider: OidcProviderAdminClient,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  async createUser(
    input: CreateIdentityUserInput,
  ): Promise<CreatedIdentityUser> {
    const { pat, hostHeader } = await this.connection();
    const projectId = await this.resolveProjectId(pat, hostHeader);
    const role = input.role ?? IdentityRole.USER;

    const tempPassword = input.sendInvite
      ? undefined
      : (input.tempPassword ?? this.generatePassword());

    let created;
    try {
      created = await this.oidcProvider.createHumanUser(pat, hostHeader, {
        userName: input.email,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        initialPassword: tempPassword,
        passwordChangeRequired: !input.sendInvite,
        // Admin-provisioned: the admin vouches for the address and delivers the
        // invite link out-of-band, so mark verified — otherwise login stalls on
        // an email-verification code that needs SMTP we don't have yet.
        isEmailVerified: true,
      });
    } catch (err) {
      throw this.translateProviderError(err, 'createUser');
    }

    await this.applyRole(pat, hostHeader, projectId, created.id, role);

    if (input.sendInvite) {
      // Flui owns the invite transport: instead of asking the provider to email
      // the user (which needs SMTP), we have it return the invite code and
      // surface a copyable link. Switching to actually emailing it is a later step.
      // First force the email verified so the invite flow completes without an
      // email-verification code (best-effort: never block account creation on it).
      try {
        await this.oidcProvider.setEmailVerified(
          pat,
          hostHeader,
          created.id,
          input.email,
        );
      } catch (err) {
        this.logger.warn(
          `setEmailVerified failed for ${created.id}: ${(err as Error).message}`,
        );
      }
      const invite = await this.makeInvite(pat, hostHeader, created.id);
      return {
        id: created.id,
        email: input.email,
        role,
        inviteLink: invite.inviteLink,
        inviteCode: invite.inviteCode,
      };
    }

    return {
      id: created.id,
      email: input.email,
      role,
      tempPassword,
    };
  }

  async createInviteLink(id: string): Promise<InviteLink> {
    const { pat, hostHeader } = await this.connection();
    const u = await this.oidcProvider.getUser(pat, hostHeader, id);
    if (!u) throw new NotFoundException(`User ${id} not found`);
    return this.makeInvite(pat, hostHeader, id);
  }

  async listUsers(query?: ListIdentityUsersQuery): Promise<IdentityUser[]> {
    const { pat, hostHeader } = await this.connection();
    const projectId = await this.resolveProjectId(pat, hostHeader);
    const users = await this.oidcProvider.listUsers(pat, hostHeader, query);
    const localBySub = new Map<string, UserEntity>();
    if (users.length > 0) {
      const rows = await this.userRepo
        .createQueryBuilder('u')
        .where('u.oidcSub IN (:...ids)', { ids: users.map((u) => u.id) })
        .getMany();
      for (const r of rows) if (r.oidcSub) localBySub.set(r.oidcSub, r);
    }

    const enriched: IdentityUser[] = [];
    for (const u of users) {
      const grants = await this.oidcProvider.listUserGrants(
        pat,
        hostHeader,
        u.id,
      );
      const fluiGrant = grants.find((g) => g.projectId === projectId);
      const role = this.deriveRole(
        fluiGrant?.roleKeys,
        localBySub.get(u.id)?.role,
      );
      enriched.push({
        id: u.id,
        email: u.email ?? u.userName,
        firstName: u.firstName,
        lastName: u.lastName,
        role,
        state: u.state,
        isBootstrapAdmin: this.isBootstrapAdminEmail(u.email ?? u.userName),
        isSystemUser:
          u.userName?.startsWith(FLUI_ADMIN_USERNAME_PREFIX) ?? false,
      });
    }
    return enriched;
  }

  async getUser(id: string): Promise<IdentityUser | null> {
    const { pat, hostHeader } = await this.connection();
    const projectId = await this.resolveProjectId(pat, hostHeader);
    const u = await this.oidcProvider.getUser(pat, hostHeader, id);
    if (!u) return null;
    const grants = await this.oidcProvider.listUserGrants(pat, hostHeader, id);
    const fluiGrant = grants.find((g) => g.projectId === projectId);
    const local = await this.userRepo.findOne({ where: { oidcSub: id } });
    return {
      id: u.id,
      email: u.email ?? u.userName,
      firstName: u.firstName,
      lastName: u.lastName,
      role: this.deriveRole(fluiGrant?.roleKeys, local?.role),
      state: u.state,
      isBootstrapAdmin: this.isBootstrapAdminEmail(u.email ?? u.userName),
      isSystemUser: u.userName?.startsWith(FLUI_ADMIN_USERNAME_PREFIX) ?? false,
    };
  }

  async deleteUser(id: string): Promise<void> {
    const { pat, hostHeader } = await this.connection();
    const u = await this.oidcProvider.getUser(pat, hostHeader, id);
    if (!u) throw new NotFoundException(`User ${id} not found`);
    if (u.userName?.startsWith(FLUI_ADMIN_USERNAME_PREFIX)) {
      throw new ConflictException(
        'Cannot delete the system admin user provisioned by the OIDC provider',
      );
    }
    if (this.isBootstrapAdminEmail(u.email ?? u.userName)) {
      throw new ConflictException('Cannot delete the bootstrap admin user');
    }
    try {
      await this.oidcProvider.deleteUser(pat, hostHeader, id);
    } catch (err) {
      throw this.translateProviderError(err, 'deleteUser');
    }
    await this.userRepo.delete({ oidcSub: id });
  }

  async setRole(id: string, role: IdentityRole): Promise<void> {
    const { pat, hostHeader } = await this.connection();
    const projectId = await this.resolveProjectId(pat, hostHeader);
    const u = await this.oidcProvider.getUser(pat, hostHeader, id);
    if (!u) throw new NotFoundException(`User ${id} not found`);
    await this.applyRole(pat, hostHeader, projectId, id, role);

    const local = await this.userRepo.findOne({ where: { oidcSub: id } });
    if (local) {
      local.role = role;
      local.isAdmin = role === IdentityRole.ADMIN;
      await this.userRepo.save(local);
    }
  }

  async resetPassword(
    id: string,
    sendInvite: boolean,
  ): Promise<{
    tempPassword?: string;
    inviteLink?: string;
    inviteCode?: string;
  }> {
    const { pat, hostHeader } = await this.connection();
    const u = await this.oidcProvider.getUser(pat, hostHeader, id);
    if (!u) throw new NotFoundException(`User ${id} not found`);
    if (sendInvite) {
      const invite = await this.makeInvite(pat, hostHeader, id);
      return { inviteLink: invite.inviteLink, inviteCode: invite.inviteCode };
    }
    const tempPassword = this.generatePassword();
    try {
      await this.oidcProvider.setUserPassword(
        pat,
        hostHeader,
        id,
        tempPassword,
        true,
      );
    } catch (err) {
      throw this.translateProviderError(err, 'resetPassword');
    }
    return { tempPassword };
  }

  private async applyRole(
    pat: string,
    hostHeader: string,
    projectId: string,
    userId: string,
    role: IdentityRole,
  ): Promise<void> {
    const grants = await this.oidcProvider.listUserGrants(
      pat,
      hostHeader,
      userId,
    );
    const fluiGrant = grants.find((g) => g.projectId === projectId);
    if (fluiGrant?.roleKeys.length === 1 && fluiGrant.roleKeys[0] === role) {
      return;
    }
    if (fluiGrant) {
      await this.oidcProvider.revokeUserGrant(
        pat,
        hostHeader,
        userId,
        fluiGrant.grantId,
      );
    }
    await this.oidcProvider.grantUserRole(pat, hostHeader, userId, projectId, [
      role,
    ]);
  }

  private deriveRole(
    roleKeys: string[] | undefined,
    fallback: IdentityRole | undefined,
  ): IdentityRole {
    if (!roleKeys || roleKeys.length === 0) {
      return fallback ?? IdentityRole.USER;
    }
    const order: IdentityRole[] = [
      IdentityRole.ADMIN,
      IdentityRole.USER,
      IdentityRole.READONLY,
    ];
    for (const r of order) if (roleKeys.includes(r)) return r;
    return IdentityRole.USER;
  }

  private async resolveProjectId(
    pat: string,
    hostHeader: string,
  ): Promise<string> {
    if (this.cachedProjectId) return this.cachedProjectId;
    const project = await this.oidcProvider.findProjectByName(
      pat,
      hostHeader,
      FLUI_PROJECT_NAME,
    );
    if (!project) {
      throw new InternalServerErrorException(
        'Flui project is not provisioned on the OIDC provider — bootstrap may be incomplete',
      );
    }
    this.cachedProjectId = project.id;
    return project.id;
  }

  private async connection(): Promise<{ pat: string; hostHeader: string }> {
    const pat = process.env.ZITADEL_SERVICE_ACCOUNT_PAT;
    if (!pat) {
      throw new NotImplementedException(
        'OIDC provider PAT not available — bootstrap may not have completed',
      );
    }
    const cluster = await this.clusterRepo.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
    });
    if (!cluster?.masterIpAddress) {
      throw new InternalServerErrorException(
        'Control cluster master IP unknown — cannot reach OIDC provider',
      );
    }
    return {
      pat,
      hostHeader: buildSystemNipHostname(
        'auth',
        cluster.masterIpAddress,
        cluster.nipHostnameToken,
      ),
    };
  }

  private isBootstrapAdminEmail(email?: string): boolean {
    if (!email) return false;
    const expected = process.env.ADMIN_EMAIL || 'admin@flui.cloud';
    return email.toLowerCase() === expected.toLowerCase();
  }

  private async makeInvite(
    pat: string,
    hostHeader: string,
    userId: string,
  ): Promise<InviteLink> {
    let code: { code: string; orgId?: string };
    try {
      code = await this.oidcProvider.createInviteCode(pat, hostHeader, userId);
    } catch (err) {
      throw this.translateProviderError(err, 'createInviteLink');
    }
    return {
      inviteLink: this.buildInviteLink(
        hostHeader,
        userId,
        code.code,
        code.orgId,
      ),
      inviteCode: code.code,
      userId,
      organizationId: code.orgId,
    };
  }

  /**
   * Builds the user-facing verification link from the provider's invite code.
   * The path differs across provider login UIs, so it is overridable via
   * OIDC_INVITE_LINK_TEMPLATE ({base}/{userId}/{code}/{orgId} placeholders).
   * The raw code travels alongside the link as the authoritative fallback.
   */
  private buildInviteLink(
    authHost: string,
    userId: string,
    code: string,
    orgId?: string,
  ): string {
    const base = `https://${authHost}`;
    // Default targets the bundled (legacy) login's invite-acceptance page, which
    // verifies the v2 invite code (validated live). Override via
    // OIDC_INVITE_LINK_TEMPLATE if a different login UI (e.g. login v2) is served.
    const template =
      process.env.OIDC_INVITE_LINK_TEMPLATE ??
      '{base}/ui/login/user/invite?userID={userId}&code={code}&orgID={orgId}';
    return template
      .replaceAll('{base}', base)
      .replaceAll('{userId}', encodeURIComponent(userId))
      .replaceAll('{code}', encodeURIComponent(code))
      .replaceAll('{orgId}', encodeURIComponent(orgId ?? ''));
  }

  /**
   * Zitadel's default policy demands upper, lower, digit and symbol. Drawing 16
   * chars uniformly from the pooled set left roughly one creation in eight with
   * no symbol at all, which the provider rejected — so take one from each class
   * first, then fill and shuffle.
   */
  private generatePassword(): string {
    const classes = [
      'ABCDEFGHJKLMNPQRSTUVWXYZ',
      'abcdefghijkmnpqrstuvwxyz',
      '23456789',
      '!@#$%^&*',
    ];
    const all = classes.join('');
    const pick = (set: string) => set[crypto.randomInt(set.length)];

    const chars = classes.map((set) => pick(set));
    while (chars.length < 16) chars.push(pick(all));

    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }

  private translateProviderError(err: unknown, op: string): Error {
    const status = (err as { response?: { status?: number } }).response?.status;
    const data = (err as { response?: { data?: any } }).response?.data;
    const code = data?.code;
    const message = data?.message ?? (err as Error).message ?? 'unknown error';
    if (status === 409 || code === 6 || /already exists/i.test(message)) {
      return new ConflictException(message);
    }
    if (/smtp|email .* not configured|notification/i.test(message)) {
      return new BadGatewayException({
        code: 'INVITE_TRANSPORT_NOT_CONFIGURED',
        message:
          'OIDC provider could not send the invite email — configure SMTP on the provider',
      });
    }
    this.logger.error(`OIDC ${op} failed: ${message}`);
    return new InternalServerErrorException(`OIDC ${op} failed: ${message}`);
  }
}
