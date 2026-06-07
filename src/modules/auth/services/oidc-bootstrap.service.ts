import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { OidcProviderAdminClient } from '../../oidc/services/oidc-provider-admin.service';
import { OidcIdentityBranding } from '../../oidc/services/oidc-identity-branding.service';
import { buildSystemNipHostname } from '../../dns/utils/nip-hostname.util';

const FLUI_PROJECT_NAME = 'Flui';
const FLUI_ADMIN_ROLE = 'admin';
const FLUI_OIDC_APP_NAME = 'Flui Web';
const FLUI_CLI_APP_NAME = 'Flui CLI';
const FLUI_MCP_APP_NAME = 'Flui MCP';
const FLUI_ADMIN_USERNAME_PREFIX = 'flui-admin';

/**
 * MCP agent scopes, provisioned as Flui project roles. createNativeOidcApp sets
 * accessTokenRoleAssertion, so a token minted for the Flui MCP app carries any
 * granted mcp:* role in its roles claim — which McpScopeResolver maps to scopes.
 */
const FLUI_MCP_ROLES: ReadonlyArray<{ key: string; displayName: string }> = [
  { key: 'mcp:catalog:read', displayName: 'MCP — catalog read' },
  { key: 'mcp:app:read', displayName: 'MCP — application read' },
  { key: 'mcp:obs:read', displayName: 'MCP — observability read' },
  { key: 'mcp:spec:validate', displayName: 'MCP — spec validate' },
  { key: 'mcp:app:write', displayName: 'MCP — application write' },
  { key: 'mcp:app:destructive', displayName: 'MCP — application destructive' },
];

const FLUI_PROJECT_ROLES: ReadonlyArray<{ key: string; displayName: string }> =
  [
    { key: 'admin', displayName: 'Administrator' },
    { key: 'user', displayName: 'User' },
    { key: 'readonly', displayName: 'Read-only / Demo' },
  ];

/** Frontend dev server URLs registered as additional redirect targets. */
const FLUI_WEB_DEV_ORIGINS = ['http://localhost:4200'];

const buildWebRedirectUris = (
  masterIp: string,
  token?: string | null,
): string[] => [
  `https://${buildSystemNipHostname('app', masterIp, token)}/auth/callback`,
  ...FLUI_WEB_DEV_ORIGINS.map((o) => `${o}/auth/callback`),
];

const buildWebPostLogoutUris = (
  masterIp: string,
  token?: string | null,
): string[] => {
  const base = `https://${buildSystemNipHostname('app', masterIp, token)}`;
  return [
    base,
    `${base}/login?loggedOut=true`,
    ...FLUI_WEB_DEV_ORIGINS,
    ...FLUI_WEB_DEV_ORIGINS.map((o) => `${o}/login?loggedOut=true`),
  ];
};

export const FLUI_CLI_CALLBACK_PORTS = [8899, 8900, 8901, 8902, 8910];
export const FLUI_CLI_REDIRECT_URIS = FLUI_CLI_CALLBACK_PORTS.map(
  (p) => `http://localhost:${p}/callback`,
);

export interface OidcBootstrapResult {
  projectId: string;
  appId: string;
  clientId: string;
  cliClientId: string;
  mcpClientId?: string;
  issuer: string;
  adminGranted: boolean;
  configMapsPatched: boolean;
}

/**
 * Performs the one-time OIDC provider setup for an control cluster:
 * creates the Flui project, admin role, OIDC SPA app, grants the role to
 * flui-admin, patches flui-api-config / flui-web-config / flui-secrets and
 * triggers a rolling restart of flui-api and flui-web.
 *
 * Idempotent — every step checks for existing state before acting.
 */
@Injectable()
export class OidcBootstrapService {
  private readonly logger = new Logger(OidcBootstrapService.name);

  private cachedPublicOidc: {
    issuer?: string;
    clientId?: string;
    cliClientId?: string;
  } | null = null;

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly oidcProvider: OidcProviderAdminClient,
    private readonly oidcBranding: OidcIdentityBranding,
  ) {}

  /**
   * Idempotently creates the Flui CLI native OIDC app and stores its clientId
   * in flui-api-config. Safe to call on existing installs.
   */
  async provisionCliApp(): Promise<{ clientId: string }> {
    const cluster = await this.clusterRepository.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
    });
    if (!cluster) {
      throw new BadRequestException('Control cluster not registered yet');
    }
    const kubeconfig = await this.getKubeconfig(cluster);
    const issuer = process.env.OIDC_ISSUER ?? process.env.ZITADEL_ISSUER ?? '';
    const providerDomain = issuer.replace('https://', '');
    const pat = await this.readOrInjectPat(kubeconfig);
    const project = await this.ensureProject(pat, providerDomain);
    const cliApp = await this.ensureCliApp(pat, providerDomain, project.id);
    await this.patchApiConfigMap(kubeconfig, issuer, cliApp.clientId);
    return { clientId: cliApp.clientId };
  }

  /**
   * Idempotently provisions the dedicated "Flui MCP" native OIDC app + the mcp:*
   * scope roles, and stores OIDC_MCP_CLIENT_ID in flui-api-config. Run once on
   * existing installs to enable the MCP agent surface. Unlike the bootstrap path,
   * errors here surface to the caller.
   */
  async provisionMcpApp(): Promise<{ mcpClientId: string }> {
    const cluster = await this.clusterRepository.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
    });
    if (!cluster) {
      throw new BadRequestException('Control cluster not registered yet');
    }
    const kubeconfig = await this.getKubeconfig(cluster);
    const issuer = process.env.OIDC_ISSUER ?? process.env.ZITADEL_ISSUER ?? '';
    const providerDomain = issuer.replace('https://', '');
    const pat = await this.readOrInjectPat(kubeconfig);
    const project = await this.ensureProject(pat, providerDomain);
    await this.ensureMcpRoles(pat, providerDomain, project.id);
    const app = await this.ensureMcpApp(pat, providerDomain, project.id);
    process.env.OIDC_MCP_CLIENT_ID = app.clientId;
    await this.patchApiConfigMap(kubeconfig, issuer, undefined, app.clientId);
    this.logger.log(
      `MCP OIDC app provisioned: ${app.appId} (client ${app.clientId})`,
    );
    return { mcpClientId: app.clientId };
  }

  /**
   * Runs the full bootstrap against the control cluster. Caller is
   * expected to have already verified that AUTH_MODE=oidc and OIDC_ISSUER is
   * empty — this service does not re-check those conditions.
   */
  async bootstrap(): Promise<OidcBootstrapResult> {
    const cluster = await this.clusterRepository.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
    });
    if (!cluster) {
      throw new BadRequestException('Control cluster not registered yet');
    }
    if (!cluster.masterIpAddress) {
      throw new BadRequestException('Control cluster has no master IP');
    }

    const kubeconfig = await this.getKubeconfig(cluster);
    const providerDomain = buildSystemNipHostname(
      'auth',
      cluster.masterIpAddress,
      cluster.nipHostnameToken,
    );
    const issuer = `https://${providerDomain}`;

    const ready = await this.oidcProvider.isReady(providerDomain);
    if (!ready) {
      throw new BadRequestException(
        `OIDC provider not ready at ${providerDomain} — retry later`,
      );
    }

    const pat = await this.readOrInjectPat(kubeconfig);

    const userName = await this.oidcProvider.verifyPat(pat, providerDomain);
    if (!userName) {
      throw new BadRequestException('OIDC provider PAT verification failed');
    }
    this.logger.log(`Authenticated on OIDC provider as: ${userName}`);

    const project = await this.ensureProject(pat, providerDomain);
    await this.ensureRoles(pat, providerDomain, project.id);
    const app = await this.ensureOidcApp(
      pat,
      providerDomain,
      project.id,
      cluster.masterIpAddress,
      cluster.nipHostnameToken,
    );
    const patched = await this.oidcProvider.ensureRoleAssertionFlags(
      pat,
      providerDomain,
      project.id,
      app.appId,
    );
    if (patched) {
      this.logger.log(`Enabled role assertion flags on OIDC app ${app.appId}`);
    }
    const cliApp = await this.ensureCliApp(pat, providerDomain, project.id);
    const mcpClientId = await this.ensureMcpAppNonFatal(
      pat,
      providerDomain,
      project.id,
    );
    const adminGranted = await this.grantAdminRole(
      pat,
      providerDomain,
      project.id,
    );

    await this.ensureBootstrapAdmin(pat, providerDomain, project.id, cluster);

    try {
      await this.oidcBranding.ensureBranding(false, {
        pat,
        hostHeader: providerDomain,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Branding application failed (non-fatal): ${message}`);
    }

    const configMapsPatched = await this.patchClusterConfigs(kubeconfig, {
      issuer,
      clientId: app.clientId,
      cliClientId: cliApp.clientId,
      mcpClientId,
      pat,
    });

    // No restart: surface in-process so this pod serves them. A self-restart
    // here used to wipe these and race the secret patch.
    process.env.OIDC_ISSUER = issuer;
    process.env.OIDC_AUDIENCE = app.clientId;
    process.env.OIDC_CLI_CLIENT_ID = cliApp.clientId;
    if (mcpClientId) process.env.OIDC_MCP_CLIENT_ID = mcpClientId;
    this.cachedPublicOidc = {
      issuer,
      clientId: app.clientId,
      cliClientId: cliApp.clientId,
    };

    const result: OidcBootstrapResult = {
      projectId: project.id,
      appId: app.appId,
      clientId: app.clientId,
      cliClientId: cliApp.clientId,
      mcpClientId,
      issuer,
      adminGranted,
      configMapsPatched,
    };

    this.logger.log(`OIDC bootstrap completed: ${JSON.stringify(result)}`);
    return result;
  }

  /** Public OIDC values; live-reads flui-secrets/flui-api-config when env is stale. */
  async getPublicOidcConfig(): Promise<{
    authMode: string;
    issuer?: string;
    clientId?: string;
    cliClientId?: string;
  }> {
    const authMode = process.env.AUTH_MODE ?? 'local';
    const issuer =
      process.env.OIDC_ISSUER || process.env.ZITADEL_ISSUER || undefined;
    const clientId = process.env.OIDC_AUDIENCE || undefined;
    const cliClientId = process.env.OIDC_CLI_CLIENT_ID || undefined;

    if (authMode !== 'oidc' || (clientId && cliClientId)) {
      return { authMode, issuer, clientId, cliClientId };
    }

    const live = await this.readLiveOidcClientIds();
    return {
      authMode,
      issuer: issuer || live.issuer,
      clientId: clientId || live.clientId,
      cliClientId: cliClientId || live.cliClientId,
    };
  }

  private async readLiveOidcClientIds(): Promise<{
    issuer?: string;
    clientId?: string;
    cliClientId?: string;
  }> {
    if (this.cachedPublicOidc?.clientId) return this.cachedPublicOidc;
    try {
      const cluster = await this.clusterRepository.findOne({
        where: {
          clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
        },
      });
      if (!cluster?.kubeconfigEncrypted) return {};
      const kubeconfig = await this.getKubeconfig(cluster);
      const [secret, cm] = await Promise.all([
        this.kubernetesService.getResource(
          kubeconfig,
          'Secret',
          'flui-secrets',
          'flui-system',
        ),
        this.kubernetesService.getResource(
          kubeconfig,
          'ConfigMap',
          'flui-api-config',
          'flui-system',
        ),
      ]);
      const secretData: Record<string, string> =
        (secret?.body ?? secret)?.data ?? {};
      const cmData: Record<string, string> = (cm?.body ?? cm)?.data ?? {};
      const audience = secretData.OIDC_AUDIENCE
        ? Buffer.from(secretData.OIDC_AUDIENCE, 'base64').toString('utf8')
        : undefined;
      const live = {
        issuer: cmData.OIDC_ISSUER || undefined,
        clientId: audience || undefined,
        cliClientId: cmData.OIDC_CLI_CLIENT_ID || undefined,
      };
      if (live.clientId) this.cachedPublicOidc = live;
      return live;
    } catch (err) {
      this.logger.warn(
        `Live OIDC config read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {};
    }
  }

  /**
   * Reads the machine-user PAT and stores it in flui-secrets if missing.
   * Preference order: env var → PVC (first-time install).
   */
  private async readOrInjectPat(kubeconfig: string): Promise<string> {
    const envPat = process.env.ZITADEL_SERVICE_ACCOUNT_PAT;
    if (envPat && envPat.length >= 20) return envPat;

    this.logger.log('Reading OIDC provider PAT from bootstrap PVC...');
    const raw = await this.kubernetesService.readPvcFile(
      kubeconfig,
      'flui-system',
      'zitadel-bootstrap-pvc',
      '/pvc/flui-api-system.pat',
    );
    const pat = raw.trim();
    if (!pat || pat.length < 20) {
      throw new BadRequestException(
        'OIDC provider PAT file is empty — provider may still be initializing',
      );
    }

    await this.kubernetesService.patchSecret(
      kubeconfig,
      'flui-system',
      'flui-secrets',
      { ZITADEL_SERVICE_ACCOUNT_PAT: pat },
    );
    return pat;
  }

  private async ensureProject(
    pat: string,
    hostHeader: string,
  ): Promise<{ id: string }> {
    const existing = await this.oidcProvider.findProjectByName(
      pat,
      hostHeader,
      FLUI_PROJECT_NAME,
    );
    if (existing) {
      this.logger.log(`Flui project already exists: ${existing.id}`);
      return { id: existing.id };
    }
    const created = await this.oidcProvider.createProject(
      pat,
      hostHeader,
      FLUI_PROJECT_NAME,
    );
    this.logger.log(`Flui project created: ${created.id}`);
    return { id: created.id };
  }

  private async ensureRoles(
    pat: string,
    hostHeader: string,
    projectId: string,
  ): Promise<void> {
    for (const role of FLUI_PROJECT_ROLES) {
      const existing = await this.oidcProvider.findRole(
        pat,
        hostHeader,
        projectId,
        role.key,
      );
      if (existing) continue;
      await this.oidcProvider.createRole(
        pat,
        hostHeader,
        projectId,
        role.key,
        role.displayName,
      );
      this.logger.log(`Role '${role.key}' created on project ${projectId}`);
    }
  }

  private async ensureOidcApp(
    pat: string,
    hostHeader: string,
    projectId: string,
    masterIp: string,
    token?: string | null,
  ): Promise<{ appId: string; clientId: string }> {
    const desiredRedirects = buildWebRedirectUris(masterIp, token);
    const desiredPostLogout = buildWebPostLogoutUris(masterIp, token);

    const existing = await this.oidcProvider.findOidcAppByName(
      pat,
      hostHeader,
      projectId,
      FLUI_OIDC_APP_NAME,
    );
    if (existing) {
      const missingRedirects = desiredRedirects.filter(
        (u) => !existing.redirectUris.includes(u),
      );
      const missingPostLogout = desiredPostLogout.filter(
        (u) => !existing.postLogoutRedirectUris.includes(u),
      );
      if (missingRedirects.length || missingPostLogout.length) {
        await this.oidcProvider.updateOidcAppUris(pat, hostHeader, existing, {
          redirectUris: [...existing.redirectUris, ...missingRedirects],
          postLogoutRedirectUris: [
            ...existing.postLogoutRedirectUris,
            ...missingPostLogout,
          ],
        });
        this.logger.log(
          `OIDC web app URIs updated: +redirects=[${missingRedirects.join(', ')}] +postLogout=[${missingPostLogout.join(', ')}]`,
        );
      } else {
        this.logger.log(
          `OIDC app already exists: ${existing.appId} (client ${existing.clientId})`,
        );
      }
      return { appId: existing.appId, clientId: existing.clientId };
    }
    const created = await this.oidcProvider.createOidcApp(
      pat,
      hostHeader,
      projectId,
      {
        name: FLUI_OIDC_APP_NAME,
        redirectUris: desiredRedirects,
        postLogoutRedirectUris: desiredPostLogout,
      },
    );
    this.logger.log(
      `OIDC app created: ${created.appId} (client ${created.clientId})`,
    );
    return { appId: created.appId, clientId: created.clientId };
  }

  private async ensureCliApp(
    pat: string,
    hostHeader: string,
    projectId: string,
  ): Promise<{ appId: string; clientId: string }> {
    const existing = await this.oidcProvider.findOidcAppByName(
      pat,
      hostHeader,
      projectId,
      FLUI_CLI_APP_NAME,
    );
    if (existing) {
      this.logger.log(
        `CLI OIDC app already exists: ${existing.appId} (client ${existing.clientId})`,
      );
      const missingUris = FLUI_CLI_REDIRECT_URIS.filter(
        (u) => !existing.redirectUris.includes(u),
      );
      if (missingUris.length > 0) {
        await this.oidcProvider.updateOidcAppUris(pat, hostHeader, existing, {
          redirectUris: [...existing.redirectUris, ...missingUris],
          postLogoutRedirectUris: existing.postLogoutRedirectUris,
        });
        this.logger.log(
          `CLI OIDC app redirect URIs updated: added ${missingUris.join(', ')}`,
        );
      }
      return { appId: existing.appId, clientId: existing.clientId };
    }
    const created = await this.oidcProvider.createNativeOidcApp(
      pat,
      hostHeader,
      projectId,
      FLUI_CLI_APP_NAME,
      FLUI_CLI_REDIRECT_URIS,
    );
    this.logger.log(
      `CLI OIDC app created: ${created.appId} (client ${created.clientId})`,
    );
    return { appId: created.appId, clientId: created.clientId };
  }

  /**
   * Provisions the dedicated "Flui MCP" native app + mcp:* scope roles. Kept
   * non-fatal: a failure here must never block the core OIDC bootstrap, since the
   * MCP surface is optional. Returns the app's clientId, or undefined on failure.
   */
  private async ensureMcpAppNonFatal(
    pat: string,
    hostHeader: string,
    projectId: string,
  ): Promise<string | undefined> {
    try {
      await this.ensureMcpRoles(pat, hostHeader, projectId);
      const app = await this.ensureMcpApp(pat, hostHeader, projectId);
      this.logger.log(
        `MCP OIDC app ready: ${app.appId} (client ${app.clientId})`,
      );
      return app.clientId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`MCP app provisioning skipped (non-fatal): ${message}`);
      return undefined;
    }
  }

  private async ensureMcpRoles(
    pat: string,
    hostHeader: string,
    projectId: string,
  ): Promise<void> {
    for (const role of FLUI_MCP_ROLES) {
      const existing = await this.oidcProvider.findRole(
        pat,
        hostHeader,
        projectId,
        role.key,
      );
      if (existing) continue;
      await this.oidcProvider.createRole(
        pat,
        hostHeader,
        projectId,
        role.key,
        role.displayName,
      );
      this.logger.log(`MCP role '${role.key}' created on project ${projectId}`);
    }
  }

  private async ensureMcpApp(
    pat: string,
    hostHeader: string,
    projectId: string,
  ): Promise<{ appId: string; clientId: string }> {
    const existing = await this.oidcProvider.findOidcAppByName(
      pat,
      hostHeader,
      projectId,
      FLUI_MCP_APP_NAME,
    );
    if (existing) {
      const missingUris = FLUI_CLI_REDIRECT_URIS.filter(
        (u) => !existing.redirectUris.includes(u),
      );
      if (missingUris.length > 0) {
        await this.oidcProvider.updateOidcAppUris(pat, hostHeader, existing, {
          redirectUris: [...existing.redirectUris, ...missingUris],
          postLogoutRedirectUris: existing.postLogoutRedirectUris,
        });
      }
      return { appId: existing.appId, clientId: existing.clientId };
    }
    const created = await this.oidcProvider.createNativeOidcApp(
      pat,
      hostHeader,
      projectId,
      FLUI_MCP_APP_NAME,
      FLUI_CLI_REDIRECT_URIS,
    );
    return { appId: created.appId, clientId: created.clientId };
  }

  private async grantAdminRole(
    pat: string,
    hostHeader: string,
    projectId: string,
  ): Promise<boolean> {
    try {
      const user = await this.oidcProvider.findUserByUsername(
        pat,
        hostHeader,
        FLUI_ADMIN_USERNAME_PREFIX,
      );
      if (!user) {
        this.logger.warn(`flui-admin user not found — skipping role grant`);
        return false;
      }
      await this.oidcProvider.grantUserRole(
        pat,
        hostHeader,
        user.id,
        projectId,
        [FLUI_ADMIN_ROLE],
      );
      this.logger.log(`Admin role granted to ${user.userName} (${user.id})`);
      return true;
    } catch (err) {
      this.logger.warn(`Could not grant admin role: ${err.message}`);
      return false;
    }
  }

  /**
   * Provisions the operational admin user on the OIDC provider using the
   * ADMIN_EMAIL / ADMIN_PASSWORD env vars injected from the K8s flui-secrets.
   * The same credentials power local-mode auth, so `flui env credentials`
   * shows a single admin login regardless of mode.
   *
   * The provider's autogenerated IAM_OWNER user is left untouched as a
   * recovery account.
   */
  private async ensureBootstrapAdmin(
    pat: string,
    hostHeader: string,
    projectId: string,
    _cluster: ClusterEntity,
  ): Promise<void> {
    const email = process.env.ADMIN_EMAIL || 'admin@flui.cloud';
    const password = process.env.ADMIN_PASSWORD;

    if (!password) {
      this.logger.warn(
        'Skipping bootstrap admin creation: ADMIN_PASSWORD env var is not set',
      );
      return;
    }

    try {
      const existing = await this.oidcProvider.findUserByEmail(
        pat,
        hostHeader,
        email,
      );
      if (existing) {
        await this.oidcProvider.grantUserRole(
          pat,
          hostHeader,
          existing.id,
          projectId,
          [FLUI_ADMIN_ROLE],
        );
        this.logger.log(
          `Bootstrap admin already exists on OIDC provider: ${email} — admin grant ensured`,
        );
        return;
      }

      const created = await this.oidcProvider.createHumanUser(pat, hostHeader, {
        userName: email,
        email,
        firstName: 'Flui',
        lastName: 'Admin',
        initialPassword: password,
        passwordChangeRequired: true,
      });
      await this.oidcProvider.grantUserRole(
        pat,
        hostHeader,
        created.id,
        projectId,
        [FLUI_ADMIN_ROLE],
      );
      this.logger.log(
        `Bootstrap admin created on OIDC provider: ${email} (id=${created.id}) — password change required at first login`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to ensure bootstrap admin on OIDC provider: ${message}`,
      );
    }
  }

  private async patchClusterConfigs(
    kubeconfig: string,
    data: {
      issuer: string;
      clientId: string;
      cliClientId: string;
      mcpClientId?: string;
      pat: string;
    },
  ): Promise<boolean> {
    try {
      await this.kubernetesService.patchSecret(
        kubeconfig,
        'flui-system',
        'flui-secrets',
        {
          OIDC_AUDIENCE: data.clientId,
          ZITADEL_SERVICE_ACCOUNT_PAT: data.pat,
        },
      );
      await this.patchApiConfigMap(
        kubeconfig,
        data.issuer,
        data.cliClientId,
        data.mcpClientId,
      );
      await this.patchWebConfigMap(kubeconfig, data.issuer, data.clientId);
      return true;
    } catch (err) {
      this.logger.error(`Failed to patch cluster configs: ${err.message}`);
      return false;
    }
  }

  private async patchApiConfigMap(
    kubeconfig: string,
    issuer: string,
    cliClientId?: string,
    mcpClientId?: string,
  ): Promise<void> {
    const cm = await this.kubernetesService.getResource(
      kubeconfig,
      'ConfigMap',
      'flui-api-config',
      'flui-system',
    );
    const body = cm?.body ?? cm;
    if (!body) throw new Error('flui-api-config ConfigMap not found');
    const existingData: Record<string, string> = { ...body.data };
    existingData['AUTH_MODE'] = 'oidc';
    existingData['OIDC_ISSUER'] = issuer;
    // Must use the public URL: the OIDC provider rejects /oauth/v2/keys when Host doesn't match its external domain.
    existingData['OIDC_JWKS_URI'] =
      `${issuer.replace(/\/+$/, '')}/oauth/v2/keys`;
    if (cliClientId) existingData['OIDC_CLI_CLIENT_ID'] = cliClientId;
    if (mcpClientId) existingData['OIDC_MCP_CLIENT_ID'] = mcpClientId;
    delete existingData['ZITADEL_ISSUER'];
    delete existingData['ZITADEL_JWKS_URI'];

    const dataLines = Object.entries(existingData)
      .map(([k, v]) => `  ${k}: "${v}"`)
      .join('\n');
    const manifest = [
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      `  name: ${body.metadata?.name ?? 'flui-api-config'}`,
      `  namespace: ${body.metadata?.namespace ?? 'flui-system'}`,
      'data:',
      dataLines,
    ].join('\n');
    await this.kubernetesService.replaceManifest(kubeconfig, manifest);
  }

  private async patchWebConfigMap(
    kubeconfig: string,
    issuer: string,
    clientId: string,
  ): Promise<void> {
    const cm = await this.kubernetesService.getResource(
      kubeconfig,
      'ConfigMap',
      'flui-web-config',
      'flui-system',
    );
    const body = cm?.body ?? cm;
    if (!body) throw new Error('flui-web-config ConfigMap not found');
    const raw = body.data?.['config.json'] ?? '{}';
    let config: Record<string, string>;
    try {
      config = JSON.parse(raw);
    } catch {
      config = {};
    }
    config.authMode = 'oidc';
    config.oidcIssuer = issuer;
    config.oidcClientId = clientId;
    const updated = JSON.stringify(config, null, 2);
    const manifest = [
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      `  name: ${body.metadata?.name ?? 'flui-web-config'}`,
      `  namespace: ${body.metadata?.namespace ?? 'flui-system'}`,
      'data:',
      '  config.json: |',
      ...updated.split('\n').map((line) => `    ${line}`),
    ].join('\n');
    await this.kubernetesService.replaceManifest(kubeconfig, manifest);
  }

  private async getKubeconfig(cluster: ClusterEntity): Promise<string> {
    if (!cluster.kubeconfigEncrypted) {
      throw new BadRequestException(
        `Cluster ${cluster.id} has no kubeconfig stored`,
      );
    }
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    return this.kubernetesService.patchKubeconfigServer(kubeconfig);
  }
}
