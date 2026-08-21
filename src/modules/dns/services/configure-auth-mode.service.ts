import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { AppManagementService } from '../../applications/services/app-management.service';
import { ConfigureAuthModeDto } from '../dto/configure-auth-mode.dto';
import { ConfigureAuthModeResultDto } from '../dto/configure-auth-mode-result.dto';
import { ApiKeyService } from '../../auth/services/api-key.service';
import { SERVICE_IDENTITY } from '../../auth/constants/service-identities';

@Injectable()
export class ConfigureAuthModeService {
  private readonly logger = new Logger(ConfigureAuthModeService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applicationRepository: Repository<ApplicationEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly appManagementService: AppManagementService,
    private readonly apiKeyService: ApiKeyService,
  ) {}

  async configureAuthMode(
    dto: ConfigureAuthModeDto,
  ): Promise<ConfigureAuthModeResultDto> {
    // Auth config is platform-wide — always targets the control cluster
    const cluster = await this.clusterRepository.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
    });
    if (!cluster) {
      throw new NotFoundException(
        'Control cluster not found. Ensure the cluster is registered in the database.',
      );
    }

    const kubeconfig = await this.getKubeconfig(cluster);

    if (dto.authMode === 'local' && !dto.jwtSecret) {
      throw new BadRequestException(
        'jwtSecret is required when authMode=local',
      );
    }
    if (dto.authMode === 'oidc' && (!dto.oidcIssuer || !dto.oidcClientId)) {
      throw new BadRequestException(
        'oidcIssuer and oidcClientId are required when authMode=oidc',
      );
    }

    const previousAuthMode = await this.readCurrentAuthMode(kubeconfig);

    this.logger.log(
      `Switching platform auth mode: ${previousAuthMode} → ${dto.authMode}`,
    );

    // Generate or reuse API key for CLI M2M access (local mode only)
    let apiKey: string | undefined;
    if (dto.authMode === 'local') {
      const identity = SERVICE_IDENTITY.CLI_SERVICE_ACCOUNT;
      apiKey = await this.apiKeyService.getActiveKey(identity.keyName);
      if (!apiKey) {
        const generated = await this.apiKeyService.generateApiKey(
          identity.keyName,
          identity.id,
        );
        apiKey = generated.plaintext;
        this.logger.log('Generated new CLI service account API key');
      }
    }

    const secretPatched = await this.patchSecret(kubeconfig, dto, apiKey);
    const apiConfigMapPatched = await this.updateApiConfigMap(kubeconfig, dto);
    const webConfigMapPatched = await this.updateWebConfigMap(kubeconfig, dto);

    const fluiApiApp = await this.findApp(cluster.id, 'flui-api');
    const fluiWebApp = await this.findApp(cluster.id, 'flui-web');

    const apiDeploymentRestarted = fluiApiApp
      ? await this.restartViaManagement(fluiApiApp.id)
      : false;
    const webDeploymentRestarted = fluiWebApp
      ? await this.restartViaManagement(fluiWebApp.id)
      : false;

    const result: ConfigureAuthModeResultDto = {
      previousAuthMode,
      newAuthMode: dto.authMode,
      secretPatched,
      apiConfigMapPatched,
      webConfigMapPatched,
      apiDeploymentRestarted,
      webDeploymentRestarted,
      apiKey,
    };

    this.logger.log(
      `Auth mode configuration completed: ${JSON.stringify(result)}`,
    );

    return result;
  }

  private async readCurrentAuthMode(kubeconfig: string): Promise<string> {
    try {
      const configMap = await this.kubernetesService.getResource(
        kubeconfig,
        'ConfigMap',
        'flui-api-config',
        'flui-system',
      );
      const cmBody = configMap?.body ?? configMap;
      return cmBody?.data?.['AUTH_MODE'] ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private async patchSecret(
    kubeconfig: string,
    dto: ConfigureAuthModeDto,
    apiKey?: string,
  ): Promise<boolean> {
    try {
      const secretData: Record<string, string> = {};

      if (dto.authMode === 'local') {
        secretData['JWT_SECRET'] = dto.jwtSecret;
        if (dto.adminEmail) secretData['ADMIN_EMAIL'] = dto.adminEmail;
        if (dto.adminPassword) secretData['ADMIN_PASSWORD'] = dto.adminPassword;
        if (apiKey) secretData['FLUI_API_KEY'] = apiKey;
      } else {
        secretData['OIDC_AUDIENCE'] = dto.oidcClientId;
      }

      await this.kubernetesService.patchSecret(
        kubeconfig,
        'flui-system',
        'flui-secrets',
        secretData,
      );
      this.logger.log(`flui-secrets patched for authMode=${dto.authMode}`);
      return true;
    } catch (err) {
      this.logger.error(`Failed to patch flui-secrets: ${err.message}`);
      return false;
    }
  }

  private async updateApiConfigMap(
    kubeconfig: string,
    dto: ConfigureAuthModeDto,
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

      data['AUTH_MODE'] = dto.authMode;
      data['OIDC_ISSUER'] = dto.authMode === 'oidc' ? dto.oidcIssuer : '';
      // Stable in-cluster URL avoids TLS validation against app endpoints.
      data['OIDC_JWKS_URI'] =
        dto.authMode === 'oidc'
          ? 'http://zitadel.flui-system.svc.cluster.local:8080/oauth/v2/keys'
          : '';
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
        `flui-api-config ConfigMap updated: AUTH_MODE=${dto.authMode}`,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to update flui-api-config ConfigMap: ${err.message}`,
      );
      return false;
    }
  }

  private async updateWebConfigMap(
    kubeconfig: string,
    dto: ConfigureAuthModeDto,
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
        config = {};
      }

      config['authMode'] = dto.authMode;
      config['oidcIssuer'] = dto.authMode === 'oidc' ? dto.oidcIssuer : '';
      config['oidcClientId'] = dto.authMode === 'oidc' ? dto.oidcClientId : '';
      // Drop legacy keys no longer consumed by the dashboard.
      delete config['apiUrl'];
      delete config['authUrl'];

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
        `flui-web-config ConfigMap updated: authMode=${dto.authMode}`,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to update flui-web-config ConfigMap: ${err.message}`,
      );
      return false;
    }
  }

  private async findApp(
    clusterId: string,
    slug: string,
  ): Promise<ApplicationEntity | null> {
    const app = await this.applicationRepository.findOne({
      where: { clusterId, slug },
    });
    if (!app) {
      this.logger.warn(
        `Application "${slug}" not found in control cluster — restart skipped`,
      );
    }
    return app;
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
        `Control cluster ${cluster.id} has no kubeconfig stored`,
      );
    }
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    return this.kubernetesService.patchKubeconfigServer(kubeconfig);
  }
}
