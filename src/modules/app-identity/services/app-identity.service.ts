import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationEnvVar } from '../../applications/interfaces/source-config.interface';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import { AppEndpointService } from '../../dns/services/app-endpoint.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  IDENTITY_COMPONENT,
  IDENTITY_KEY_VAR,
  IDENTITY_PROJECT,
  IdentityPoolResolver,
  ResolvedPool,
} from './identity-pool.resolver';
import {
  AppIdentityEnvNames,
  AppIdentityLinkEntity,
} from '../entities/app-identity-link.entity';
import { IdentityUser, InvitedUser } from '../zitadel/identity-pool';

export const DEFAULT_ENV_NAMES: AppIdentityEnvNames = {
  issuer: 'OIDC_ISSUER',
  clientId: 'OIDC_CLIENT_ID',
  clientSecret: 'OIDC_CLIENT_SECRET',
};

export interface IdentityInstall {
  identityInstallId: string;
  applicationId: string;
  name: string;
  issuer: string | null;
  managed: boolean;
}

export interface ConnectIdentity {
  identityInstallId: string;
  redirectPaths: string[];
  envNames?: Partial<AppIdentityEnvNames>;
}

/**
 * Sign-in for the users of a customer's own applications, served by an
 * identity install of theirs. Never the identity provider that runs Flui:
 * the two never share an installation.
 */
@Injectable()
export class AppIdentityService {
  constructor(
    @InjectRepository(AppIdentityLinkEntity)
    private readonly links: Repository<AppIdentityLinkEntity>,
    private readonly applications: ApplicationsRepository,
    private readonly endpoints: AppEndpointService,
    private readonly encryption: EncryptionService,
    private readonly access: ApplicationAccessService,
    private readonly deploy: ApplicationDeployService,
    @InjectRepository(ApplicationEntity)
    private readonly appRows: Repository<ApplicationEntity>,
    private readonly resolver: IdentityPoolResolver,
  ) {}

  /** The identity installs the caller may read; `managed` is false for one that predates the management key. */
  async installs(user: AuthenticatedUser): Promise<IdentityInstall[]> {
    const servers = await this.appRows
      .createQueryBuilder('a')
      .where(`a.metadata ->> 'composedComponent' = :c`, {
        c: IDENTITY_COMPONENT,
      })
      .andWhere(`a.metadata ->> 'catalogInstallId' IS NOT NULL`)
      .andWhere({ deletedAt: IsNull() })
      .getMany();
    const readable = await this.access.filterReadable(user, servers);
    const rows: IdentityInstall[] = [];
    for (const server of readable) {
      const [endpoint] = await this.endpoints.listByApplicationId(server.id);
      rows.push({
        identityInstallId: server.metadata.catalogInstallId,
        applicationId: server.id,
        name: server.name ?? server.slug,
        issuer: endpoint?.fqdn ? `https://${endpoint.fqdn}` : null,
        managed: !!server.env?.some((e) => e.name === IDENTITY_KEY_VAR),
      });
    }
    return rows;
  }

  async users(
    user: AuthenticatedUser,
    installId: string,
  ): Promise<IdentityUser[]> {
    const { pool } = await this.poolFor(user, installId, 'app:read');
    return pool.listUsers();
  }

  async invite(
    user: AuthenticatedUser,
    installId: string,
    invited: InvitedUser,
  ): Promise<{ id: string }> {
    const { pool } = await this.poolFor(user, installId, 'app:write');
    return pool.inviteUser(invited);
  }

  /** Password hashes and OTP secrets: as sensitive as the install itself, so it asks write on it. */
  async exportUsers(
    user: AuthenticatedUser,
    installId: string,
  ): Promise<unknown> {
    const { pool } = await this.poolFor(user, installId, 'app:write');
    return pool.exportUsers();
  }

  async setBlocked(
    user: AuthenticatedUser,
    installId: string,
    userId: string,
    blocked: boolean,
  ): Promise<void> {
    const { pool } = await this.poolFor(user, installId, 'app:write');
    await (blocked ? pool.blockUser(userId) : pool.unblockUser(userId));
  }

  async linkOf(
    user: AuthenticatedUser,
    applicationId: string,
  ): Promise<AppIdentityLinkEntity | null> {
    const app = await this.application(applicationId);
    await this.access.assertCan(user, 'app:read', app);
    return this.links.findOne({ where: { applicationId } });
  }

  async connect(
    user: AuthenticatedUser,
    applicationId: string,
    request: ConnectIdentity,
  ): Promise<AppIdentityLinkEntity> {
    const app = await this.application(applicationId);
    await this.access.assertCan(user, 'app:write', app);
    if (await this.links.findOne({ where: { applicationId } })) {
      throw new ConflictException(
        'This application already signs in with an identity install; disconnect it first.',
      );
    }
    const { pool, issuer } = await this.poolFor(
      user,
      request.identityInstallId,
      'app:write',
    );
    const origin = `https://${await this.resolver.addressOf(app)}`;
    const redirectUris = request.redirectPaths.map((p) => `${origin}${p}`);
    const envNames = { ...DEFAULT_ENV_NAMES, ...request.envNames };

    const projectId = await pool.ensureProject(IDENTITY_PROJECT);
    const client = await pool.createClient(projectId, {
      name: app.slug,
      redirectUris,
      postLogoutRedirectUris: [`${origin}/`],
    });
    try {
      const link = await this.links.save(
        this.links.create({
          applicationId,
          identityInstallId: request.identityInstallId,
          projectId,
          clientAppId: client.appId,
          clientId: client.clientId,
          issuer,
          redirectUris,
          envNames,
        }),
      );
      await this.writeEnv(
        app,
        envNames,
        [
          { name: envNames.issuer, value: issuer },
          { name: envNames.clientId, value: client.clientId },
          {
            name: envNames.clientSecret,
            value: this.encryption.encrypt(client.clientSecret),
            secret: true,
          },
        ],
        user.userId,
      );
      return link;
    } catch (error) {
      await pool.deleteClient(projectId, client.appId).catch(() => undefined);
      await this.links.delete({ applicationId }).catch(() => undefined);
      throw error;
    }
  }

  async disconnect(
    user: AuthenticatedUser,
    applicationId: string,
  ): Promise<void> {
    const app = await this.application(applicationId);
    await this.access.assertCan(user, 'app:write', app);
    const link = await this.links.findOne({ where: { applicationId } });
    if (!link) return;
    const { pool } = await this.poolFor(
      user,
      link.identityInstallId,
      'app:write',
    );
    await pool.deleteClient(link.projectId, link.clientAppId);
    await this.writeEnv(app, link.envNames, [], user.userId);
    await this.links.delete({ id: link.id });
  }

  private async writeEnv(
    app: ApplicationEntity,
    names: AppIdentityEnvNames,
    entries: ApplicationEnvVar[],
    userId: string,
  ): Promise<void> {
    const owned = new Set([names.issuer, names.clientId, names.clientSecret]);
    const env = [
      ...(app.env ?? []).filter((e) => !owned.has(e.name)),
      ...entries.map((e) => ({ ...e, source: 'link' as const })),
    ];
    await this.applications.update(app.id, { env });
    if (app.imageRef) {
      await this.deploy.deploy(app.id, { useCurrentImage: true }, userId);
    }
  }

  private async application(id: string): Promise<ApplicationEntity> {
    const app = await this.applications.findById(id);
    if (!app) throw new NotFoundException(`Application ${id} not found`);
    return app;
  }

  private async poolFor(
    user: AuthenticatedUser,
    installId: string,
    action: 'app:read' | 'app:write',
  ): Promise<ResolvedPool> {
    await this.access.assertCan(
      user,
      action,
      await this.resolver.server(installId),
    );
    return this.resolver.resolve(installId);
  }
}
