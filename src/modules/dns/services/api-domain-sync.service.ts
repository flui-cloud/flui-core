import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { AppEndpointEntity } from '../entities/app-endpoint.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { AppManagementService } from '../../applications/services/app-management.service';
import { SyncApiDomainDto } from '../dto/sync-api-domain.dto';
import { ApiDomainSyncResultDto } from '../dto/api-domain-sync-result.dto';

@Injectable()
export class ApiDomainSyncService {
  private readonly logger = new Logger(ApiDomainSyncService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(AppEndpointEntity)
    private readonly appEndpointRepository: Repository<AppEndpointEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly appManagementService: AppManagementService,
  ) {}

  async syncApiDomain(
    clusterId: string,
    dto: SyncApiDomainDto,
  ): Promise<ApiDomainSyncResultDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const kubeconfig = await this.getKubeconfig(cluster);

    const apiDomain = await this.resolveFqdn(
      dto.fluiApiApplicationId,
      'flui-api',
    );
    const webDomain = await this.resolveFqdn(
      dto.fluiWebApplicationId,
      'flui-web',
    );
    const authDomain = dto.zitadelApplicationId
      ? await this.resolveFqdn(dto.zitadelApplicationId, 'zitadel')
      : null;

    this.logger.log(
      `Syncing API domain config for cluster ${clusterId}: api=${apiDomain}, web=${webDomain}, auth=${authDomain ?? '(local mode)'}`,
    );

    const secretsPatched = await this.patchFluiSecrets(kubeconfig, {
      apiDomain,
      webDomain,
      authDomain,
    });

    const configMapPatched = await this.updateApiConfigMap(kubeconfig, {
      apiDomain,
      webDomain,
      authDomain,
    });

    // Restart flui-api to pick up the new environment values.
    // Uses AppManagementService to register the audit event and trigger the WebSocket rollout watcher.
    const deploymentRestarted = await this.restartViaManagement(
      dto.fluiApiApplicationId,
    );

    const result: ApiDomainSyncResultDto = {
      apiDomain,
      webDomain,
      authDomain: authDomain ?? '',
      secretsPatched,
      configMapPatched,
      deploymentRestarted,
    };

    const now = new Date();
    const [apiEndpoint, webEndpoint] = await Promise.all([
      this.resolveEndpoint(dto.fluiApiApplicationId, 'flui-api'),
      this.resolveEndpoint(dto.fluiWebApplicationId, 'flui-web'),
    ]);
    apiEndpoint.lastSyncedAt = now;
    apiEndpoint.syncedDomain = apiEndpoint.fqdn;
    webEndpoint.lastSyncedAt = now;
    webEndpoint.syncedDomain = webEndpoint.fqdn;
    await this.appEndpointRepository.save([apiEndpoint, webEndpoint]);

    this.logger.log(
      `API domain sync completed for cluster ${clusterId}: ${JSON.stringify(result)}`,
    );

    return result;
  }

  private async resolveEndpoint(
    applicationId: string,
    label: string,
  ): Promise<AppEndpointEntity> {
    const endpoint = await this.appEndpointRepository.findOne({
      where: { applicationId },
    });
    if (!endpoint?.fqdn) {
      throw new BadRequestException(
        `No FQDN configured for ${label} application (id: ${applicationId}). Configure the DNS endpoint first.`,
      );
    }
    return endpoint;
  }

  private async resolveFqdn(
    applicationId: string,
    label: string,
  ): Promise<string> {
    const endpoint = await this.appEndpointRepository.findOne({
      where: { applicationId },
    });
    if (!endpoint?.fqdn) {
      throw new BadRequestException(
        `No FQDN configured for ${label} application (id: ${applicationId}). Configure the DNS endpoint first.`,
      );
    }
    return endpoint.fqdn;
  }

  private async patchFluiSecrets(
    kubeconfig: string,
    domains: {
      apiDomain: string;
      webDomain: string;
      authDomain: string | null;
    },
  ): Promise<boolean> {
    try {
      const data: Record<string, string> = {
        PUBLIC_API_URL: `https://${domains.apiDomain}`,
        FLUI_API_ENDPOINT: `https://${domains.apiDomain}`,
        API_BASE_URL: `https://${domains.apiDomain}`,
        WEBHOOK_BASE_URL: `https://${domains.apiDomain}`,
        FRONTEND_URL: `https://${domains.webDomain}`,
      };
      if (domains.authDomain) {
        data.OIDC_ISSUER = `https://${domains.authDomain}`;
      }
      await this.kubernetesService.patchSecret(
        kubeconfig,
        'flui-system',
        'flui-secrets',
        data,
      );
      this.logger.log('flui-secrets patched with domain configuration');
      return true;
    } catch (err) {
      this.logger.error(`Failed to patch flui-secrets: ${err.message}`);
      return false;
    }
  }

  private async updateApiConfigMap(
    kubeconfig: string,
    {
      apiDomain,
      webDomain,
      authDomain,
    }: { apiDomain: string; webDomain: string; authDomain: string | null },
  ): Promise<boolean> {
    try {
      const configMap = await this.kubernetesService.getResource(
        kubeconfig,
        'ConfigMap',
        'flui-api-config',
        'flui-system',
      );

      if (!configMap) {
        this.logger.warn(
          'flui-api-config ConfigMap not found, skipping update',
        );
        return false;
      }

      const cmBody = configMap.body ?? configMap;
      const data: Record<string, string> = { ...cmBody.data };

      data['API_BASE_URL'] = `https://${apiDomain}`;
      data['WEBHOOK_BASE_URL'] = `https://${apiDomain}`;
      data['FRONTEND_URL'] = `https://${webDomain}`;
      if (authDomain) {
        data['OIDC_ISSUER'] = `https://${authDomain}`;
        if (!data['OIDC_JWKS_URI']) {
          data['OIDC_JWKS_URI'] =
            'http://zitadel.flui-system.svc.cluster.local:8080/oauth/v2/keys';
        }
      }
      delete data['ZITADEL_ISSUER'];
      delete data['ZITADEL_JWKS_URI'];

      const dataLines = Object.entries(data)
        .map(([k, v]) => `  ${k}: "${v}"`)
        .join('\n');

      const updatedManifest = [
        'apiVersion: v1',
        'kind: ConfigMap',
        'metadata:',
        `  name: ${cmBody.metadata?.name ?? 'flui-api-config'}`,
        `  namespace: ${cmBody.metadata?.namespace ?? 'flui-system'}`,
        'data:',
        dataLines,
      ].join('\n');

      await this.kubernetesService.replaceManifest(kubeconfig, updatedManifest);
      this.logger.log(
        `flui-api-config ConfigMap updated: OIDC_ISSUER=https://${authDomain}, API_BASE_URL=https://${apiDomain}, FRONTEND_URL=https://${webDomain}`,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to update flui-api-config ConfigMap: ${err.message}`,
      );
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
