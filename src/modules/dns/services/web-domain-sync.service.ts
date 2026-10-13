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
import { SyncWebDomainDto } from '../dto/sync-web-domain.dto';
import { WebDomainSyncResultDto } from '../dto/web-domain-sync-result.dto';
import { findPlatformEndpoint } from '../utils/platform-endpoint.util';

@Injectable()
export class WebDomainSyncService {
  private readonly logger = new Logger(WebDomainSyncService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(AppEndpointEntity)
    private readonly appEndpointRepository: Repository<AppEndpointEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly appManagementService: AppManagementService,
  ) {}

  async syncWebDomain(
    clusterId: string,
    dto: SyncWebDomainDto,
  ): Promise<WebDomainSyncResultDto> {
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

    const oidcIssuer = authDomain ? `https://${authDomain}` : '(local mode)';
    this.logger.log(
      `Syncing web config for cluster ${clusterId}: apiBaseUrl=https://${apiDomain}, oidcIssuer=${oidcIssuer} (web: ${webDomain})`,
    );

    const configMapUpdated = await this.updateWebConfigMap(
      kubeconfig,
      apiDomain,
      authDomain,
    );
    const deploymentRestarted = await this.restartViaManagement(
      dto.fluiWebApplicationId,
    );

    const result: WebDomainSyncResultDto = {
      apiDomain,
      authDomain: authDomain ?? '',
      configMapUpdated,
      deploymentRestarted,
    };

    const webEndpoint = await this.resolveEndpoint(
      dto.fluiWebApplicationId,
      'flui-web',
    );
    webEndpoint.lastSyncedAt = new Date();
    webEndpoint.syncedDomain = webEndpoint.fqdn;
    await this.appEndpointRepository.save(webEndpoint);

    this.logger.log(
      `Web domain sync completed for cluster ${clusterId}: ${JSON.stringify(result)}`,
    );

    return result;
  }

  private async resolveEndpoint(
    applicationId: string,
    label: string,
  ): Promise<AppEndpointEntity> {
    const endpoint = await findPlatformEndpoint(
      this.appEndpointRepository,
      applicationId,
    );
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
    const endpoint = await findPlatformEndpoint(
      this.appEndpointRepository,
      applicationId,
    );
    if (!endpoint?.fqdn) {
      throw new BadRequestException(
        `No FQDN configured for ${label} application (id: ${applicationId}). Configure the DNS endpoint first.`,
      );
    }
    return endpoint.fqdn;
  }

  private async updateWebConfigMap(
    kubeconfig: string,
    apiDomain: string,
    authDomain: string | null,
  ): Promise<boolean> {
    try {
      const configMap = await this.kubernetesService.getResource(
        kubeconfig,
        'ConfigMap',
        'flui-web-config',
        'flui-system',
      );

      if (!configMap) {
        this.logger.warn(
          'flui-web-config ConfigMap not found, skipping update',
        );
        return false;
      }

      const cmBody = configMap.body ?? configMap;
      const rawConfig: string = cmBody.data?.['config.json'] ?? '{}';

      let config: Record<string, string>;
      try {
        config = JSON.parse(rawConfig);
      } catch {
        this.logger.warn(
          'config.json is not valid JSON, initializing empty object',
        );
        config = {};
      }

      config.apiBaseUrl = `https://${apiDomain}`;
      config.wsUrl = `wss://${apiDomain}`;
      if (authDomain && config.authMode === 'oidc') {
        config.oidcIssuer = `https://${authDomain}`;
      }
      // Drop legacy keys no longer consumed by the dashboard.
      delete config.apiUrl;
      delete config.authUrl;

      const updatedJson = JSON.stringify(config, null, 2);

      const updatedManifest = [
        'apiVersion: v1',
        'kind: ConfigMap',
        'metadata:',
        `  name: ${cmBody.metadata?.name ?? 'flui-web-config'}`,
        `  namespace: ${cmBody.metadata?.namespace ?? 'flui-system'}`,
        'data:',
        '  config.json: |',
        ...updatedJson.split('\n').map((line) => `    ${line}`),
      ].join('\n');

      await this.kubernetesService.replaceManifest(kubeconfig, updatedManifest);
      this.logger.log(
        `flui-web-config ConfigMap updated with apiBaseUrl: https://${apiDomain}` +
          (authDomain ? `, oidcIssuer: https://${authDomain}` : ''),
      );
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to update flui-web-config ConfigMap: ${err.message}`,
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
