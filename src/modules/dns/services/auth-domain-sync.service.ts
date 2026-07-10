import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { AppEndpointEntity } from '../entities/app-endpoint.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { AppManagementService } from '../../applications/services/app-management.service';
import { OidcProviderAdminClient } from '../../oidc/services/oidc-provider-admin.service';
import { AuthDomainSyncResultDto } from '../dto/auth-domain-sync-result.dto';
import { SyncAuthDomainDto } from '../dto/sync-auth-domain.dto';

export { AuthDomainSyncResultDto } from '../dto/auth-domain-sync-result.dto';

@Injectable()
export class AuthDomainSyncService {
  private readonly logger = new Logger(AuthDomainSyncService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applicationRepository: Repository<ApplicationEntity>,
    @InjectRepository(AppEndpointEntity)
    private readonly appEndpointRepository: Repository<AppEndpointEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
    private readonly appManagementService: AppManagementService,
    private readonly oidcProvider: OidcProviderAdminClient,
  ) {}

  async syncAuthDomain(
    clusterId: string,
    dto: SyncAuthDomainDto,
  ): Promise<AuthDomainSyncResultDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const kubeconfig = await this.getKubeconfig(cluster);

    // 1. Recupera il nuovo FQDN dall'endpoint auth già configurato nel DB
    const authApp = await this.applicationRepository.findOne({
      where: { clusterId, slug: 'zitadel' },
    });
    if (!authApp) {
      throw new NotFoundException(
        `Auth application not found in cluster ${clusterId}`,
      );
    }

    const authEndpoint = await this.appEndpointRepository.findOne({
      where: { applicationId: authApp.id },
    });
    if (!authEndpoint?.fqdn) {
      throw new BadRequestException(
        `Auth endpoint has no FQDN configured yet. Configure the DNS endpoint first.`,
      );
    }

    const newDomain = authEndpoint.fqdn;
    const previousDomain = this.resolveCurrentAuthUrl(cluster).replace(
      'https://',
      '',
    );
    this.logger.log(
      `Syncing auth domain to "${newDomain}" (current: ${previousDomain}) for cluster ${clusterId}`,
    );

    const { pat, patInjected } = await this.bootstrapPatIfMissing(kubeconfig);

    const configMapUpdated = await this.updateAuthConfigMap(
      kubeconfig,
      newDomain,
    );

    const webDomain = await this.resolveWebFqdn(dto.fluiWebApplicationId);
    const zitadelUpdate = await this.updateZitadelAppRedirectUris(
      kubeconfig,
      pat,
      previousDomain,
      webDomain,
    );

    const deploymentRestarted = await this.restartViaManagement(authApp.id);

    const result: AuthDomainSyncResultDto = {
      previousDomain,
      newDomain,
      configMapUpdated,
      deploymentRestarted,
      patInjected,
      zitadelAppPatched: zitadelUpdate.patched,
      redirectUrisAdded: zitadelUpdate.redirectUrisAdded,
      postLogoutUrisAdded: zitadelUpdate.postLogoutUrisAdded,
    };

    authEndpoint.lastSyncedAt = new Date();
    authEndpoint.syncedDomain = newDomain;
    await this.appEndpointRepository.save(authEndpoint);

    this.logger.log(
      `Auth domain sync completed for cluster ${clusterId}: ${JSON.stringify(result)}`,
    );

    return result;
  }

  /**
   * Returns the service account PAT, injecting it into flui-secrets if not already present.
   * Reads the PAT from the Zitadel pod's bootstrap PVC (/bootstrap/flui-api-system.pat).
   */
  private async bootstrapPatIfMissing(
    kubeconfig: string,
  ): Promise<{ pat: string; patInjected: boolean }> {
    const envPat = this.configService.get<string>(
      'ZITADEL_SERVICE_ACCOUNT_PAT',
    );
    if (envPat) {
      return { pat: envPat, patInjected: false };
    }

    this.logger.log(
      'ZITADEL_SERVICE_ACCOUNT_PAT not in env — reading from Zitadel bootstrap PVC...',
    );
    let pat: string;
    try {
      const raw = await this.kubernetesService.readPvcFile(
        kubeconfig,
        'flui-system',
        'zitadel-bootstrap-pvc',
        '/pvc/flui-api-system.pat',
      );
      pat = raw.trim();
    } catch (err) {
      throw new BadRequestException(
        `Cannot read Zitadel PAT from PVC: ${err.message}. Zitadel may still be initializing — retry later.`,
      );
    }

    if (!pat || pat.length < 10) {
      throw new BadRequestException(
        'Zitadel PAT file exists but is empty. Zitadel may still be initializing — retry later.',
      );
    }

    // Inject into flui-secrets so future requests use env var
    await this.kubernetesService.patchSecret(
      kubeconfig,
      'flui-system',
      'flui-secrets',
      {
        ZITADEL_SERVICE_ACCOUNT_PAT: pat,
      },
    );
    process.env.ZITADEL_SERVICE_ACCOUNT_PAT = pat;
    this.logger.log(
      '✅ ZITADEL_SERVICE_ACCOUNT_PAT injected into flui-secrets and process env.',
    );

    return { pat, patInjected: true };
  }

  private resolveCurrentAuthUrl(cluster: ClusterEntity): string {
    const metaUrl = cluster.metadata?.['authUrl'];
    if (metaUrl) {
      return metaUrl;
    }
    const issuer =
      this.configService.get<string>('OIDC_ISSUER') ||
      this.configService.get<string>('ZITADEL_ISSUER');
    if (!issuer) {
      throw new BadRequestException(
        'Cannot determine current auth URL. Set OIDC_ISSUER in environment or authUrl in cluster metadata.',
      );
    }
    return issuer;
  }

  private async updateAuthConfigMap(
    kubeconfig: string,
    newDomain: string,
  ): Promise<boolean> {
    try {
      const configMap = await this.kubernetesService.getResource(
        kubeconfig,
        'ConfigMap',
        'zitadel-config',
        'flui-system',
      );

      if (!configMap) {
        this.logger.warn('Auth ConfigMap not found, skipping update');
        return false;
      }

      const cmBody = configMap.body ?? configMap;
      const currentConfig: string = cmBody.data?.['config.yaml'] ?? '';

      const updatedConfig = currentConfig.replace(
        /^ExternalDomain:.*$/m,
        `ExternalDomain: ${newDomain}`,
      );

      if (updatedConfig === currentConfig) {
        this.logger.warn('ExternalDomain not found in ConfigMap, skipping');
        return false;
      }

      const updatedManifest = [
        'apiVersion: v1',
        'kind: ConfigMap',
        'metadata:',
        `  name: ${cmBody.metadata?.name ?? 'zitadel-config'}`,
        `  namespace: ${cmBody.metadata?.namespace ?? 'flui-system'}`,
        'data:',
        '  config.yaml: |',
        ...updatedConfig.split('\n').map((line) => `    ${line}`),
      ].join('\n');

      await this.kubernetesService.replaceManifest(kubeconfig, updatedManifest);
      this.logger.log(
        `Auth ConfigMap updated with ExternalDomain: ${newDomain}`,
      );
      return true;
    } catch (err) {
      this.logger.error(`Failed to update auth ConfigMap: ${err.message}`);
      return false;
    }
  }

  private async restartViaManagement(applicationId: string): Promise<boolean> {
    try {
      await this.appManagementService.restartDeployment(applicationId);
      this.logger.log(
        `Deployment restart triggered for application ${applicationId}`,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to restart deployment for application ${applicationId}: ${err.message}`,
      );
      return false;
    }
  }

  private async resolveWebFqdn(applicationId: string): Promise<string> {
    const endpoint = await this.appEndpointRepository.findOne({
      where: { applicationId },
    });
    if (!endpoint?.fqdn) {
      throw new BadRequestException(
        `flui-web endpoint not found for application ${applicationId}. Configure the DNS endpoint first.`,
      );
    }
    return endpoint.fqdn;
  }

  private async updateZitadelAppRedirectUris(
    kubeconfig: string,
    pat: string,
    hostHeader: string,
    webDomain: string,
  ): Promise<{
    patched: boolean;
    redirectUrisAdded: string[];
    postLogoutUrisAdded: string[];
  }> {
    const newRedirectUri = `https://${webDomain}/auth/callback`;
    const newPostLogoutUri = `https://${webDomain}`;
    const newPostLogoutUriWithPath = `https://${webDomain}/login?loggedOut=true`;

    try {
      const project = await this.oidcProvider.findProjectByName(
        pat,
        hostHeader,
        'Flui',
      );
      if (!project) {
        this.logger.warn('Flui project not found on OIDC provider');
        return {
          patched: false,
          redirectUrisAdded: [],
          postLogoutUrisAdded: [],
        };
      }

      const app = await this.oidcProvider.findOidcAppByName(
        pat,
        hostHeader,
        project.id,
        'Flui Web',
      );
      if (!app) {
        this.logger.warn(
          `OIDC application 'Flui Web' not found in project ${project.id}`,
        );
        return {
          patched: false,
          redirectUrisAdded: [],
          postLogoutUrisAdded: [],
        };
      }

      const redirectUrisAdded = app.redirectUris.includes(newRedirectUri)
        ? []
        : [newRedirectUri];
      const missingPostLogout = [
        newPostLogoutUri,
        newPostLogoutUriWithPath,
      ].filter((u) => !app.postLogoutRedirectUris.includes(u));

      if (redirectUrisAdded.length === 0 && missingPostLogout.length === 0) {
        return {
          patched: true,
          redirectUrisAdded: [],
          postLogoutUrisAdded: [],
        };
      }

      const postLogoutUrisAdded = missingPostLogout;
      await this.oidcProvider.updateOidcAppUris(pat, hostHeader, app, {
        redirectUris: [...app.redirectUris, ...redirectUrisAdded],
        postLogoutRedirectUris: [
          ...app.postLogoutRedirectUris,
          ...postLogoutUrisAdded,
        ],
      });

      this.logger.log(
        `Zitadel app ${app.appId} patched. Added redirectUris=${JSON.stringify(redirectUrisAdded)} postLogout=${JSON.stringify(postLogoutUrisAdded)}`,
      );
      return { patched: true, redirectUrisAdded, postLogoutUrisAdded };
    } catch (err) {
      this.logger.error(
        `Failed to update Zitadel app redirect URIs: ${err.message}`,
      );
      return { patched: false, redirectUrisAdded: [], postLogoutUrisAdded: [] };
    }
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
