import {
  Injectable,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  NotImplementedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ICloudProvider,
  CreateServerConfig,
  ServerCreationResult,
  ServerDeletionResult,
  Label,
  SSHKeyCreationResult,
  SSHKeyDetails,
} from '../interfaces/cloud-provider.interface';
import { InstanceEntity } from '../../instances/entities/instance.entity';
import { InstanceStatus } from '../../instances/entities/instance-status.enum';
import { InstanceType } from '../../instances/entities/instance-type.enum';
import { CloudProvider } from '../enums/cloud-provider.enum';
import {
  Configuration,
  InstancesApi,
  ListInstancesResponseData,
} from 'src/modules/providers/implementations/contabo/generated';
import { randomUUID } from 'node:crypto';
import { ICredentialProvider } from '../interfaces/credential-provider.interface';
import { DeleteServerDto } from 'src/modules/infrastructure/servers/dto/delete-server.dto';
import { ServerResponseDto } from 'src/modules/infrastructure/servers/dto/server-response.dto';
import { SSHKeyDto } from 'src/modules/access/dto/ssh-key.dto';
import { NodeSizeDto } from '../dto/node-size.dto';
import { PricingDto, PricingQueryDto } from '../dto/pricing.dto';
import { LabelService } from '../../common/services/label.service';

@Injectable()
export class ContaboProviderService implements ICloudProvider {
  private readonly logger = new Logger(ContaboProviderService.name);
  private readonly apiUrl: string;
  private readonly FLUI_PREFIX = 'flui-';

  constructor(
    private readonly configService: ConfigService,
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
    private readonly labelService: LabelService,
  ) {
    this.apiUrl = this.configService.get<string>(
      'CONTABO_API_URL',
      'https://api.contabo.com',
    );
  }

  listServersAsDto(): Promise<ServerResponseDto[]> {
    throw new NotImplementedException(
      'Contabo provider: listServersAsDto not yet implemented',
    );
  }

  getServerDetailsAsDto(serverId: string): Promise<ServerResponseDto | null> {
    throw new NotImplementedException(
      'Contabo provider: getServerDetailsAsDto not yet implemented',
    );
  }

  createServer(config: CreateServerConfig): Promise<ServerCreationResult> {
    throw new NotImplementedException(
      'Contabo provider: createServer not yet implemented',
    );
  }

  deleteServer(config: DeleteServerDto): Promise<ServerDeletionResult> {
    throw new NotImplementedException(
      'Contabo provider: deleteServer not yet implemented',
    );
  }

  getServerStatus(serverId: string): Promise<string> {
    throw new NotImplementedException(
      'Contabo provider: getServerStatus not yet implemented',
    );
  }

  testConnection(): Promise<{ success: boolean; error?: string }> {
    throw new NotImplementedException(
      'Contabo provider: testConnection not yet implemented',
    );
  }

  async powerOnServer(serverId: string): Promise<void> {
    throw new NotImplementedException(
      'Contabo provider: powerOnServer not yet implemented',
    );
  }

  async powerOffServer(serverId: string): Promise<void> {
    throw new NotImplementedException(
      'Contabo provider: powerOffServer not yet implemented',
    );
  }

  async changeServerType(): Promise<{ actionId?: number }> {
    throw new NotImplementedException(
      'Contabo provider: changeServerType is not supported. Contabo requires re-provisioning the VPS to change its plan.',
    );
  }

  async expandVolume(): Promise<{ actionId?: number }> {
    throw new NotImplementedException(
      'Contabo provider: expandVolume is not supported.',
    );
  }

  async listInstances(
    filters?: Record<string, unknown>,
  ): Promise<InstanceEntity[]> {
    try {
      const activeToken = await this.credentialProvider.getActiveBearerToken(
        CloudProvider.CONTABO,
      );

      if (!activeToken) {
        throw new HttpException(
          'No active token found for Contabo',
          HttpStatus.UNAUTHORIZED,
        );
      }

      const configuration = new Configuration({
        basePath: 'https://api.contabo.com',
        accessToken: activeToken.access_token,
      });

      const instancesApi = new InstancesApi(configuration);
      const requestId = randomUUID();
      const instanceList = await instancesApi.retrieveInstancesList(requestId);

      return instanceList.data.data.map((instance) =>
        this.mapContaboInstanceToEntity(instance),
      );
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to list instances',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private mapContaboInstanceToEntity(
    contaboInstance: ListInstancesResponseData,
  ): InstanceEntity {
    const instance = new InstanceEntity();
    instance.providerId = String(contaboInstance.instanceId);
    instance.name = contaboInstance.name;
    instance.displayName = contaboInstance.displayName || '';
    instance.type = InstanceType.VPS;
    instance.provider = CloudProvider.CONTABO;
    instance.status = this.mapContaboStatus(contaboInstance.status);
    instance.dataCenter = contaboInstance.dataCenter;
    instance.region = contaboInstance.region;
    instance.regionName = contaboInstance.regionName;
    instance.cpuCores = contaboInstance.cpuCores;
    instance.ramMb = contaboInstance.ramMb;
    instance.diskMb = contaboInstance.diskMb;
    instance.architecture = null;
    instance.osType = contaboInstance.osType;
    instance.ipConfig = contaboInstance.ipConfig;
    instance.macAddress = contaboInstance.macAddress;
    instance.productType = contaboInstance.productType;
    instance.productName = contaboInstance.productName;
    instance.defaultUser = contaboInstance.defaultUser || '';
    instance.additionalIps =
      contaboInstance.additionalIps?.map((ip) => ip.v4.ip || '') || [];

    if (contaboInstance.createdDate) {
      instance.createdAt = new Date(contaboInstance.createdDate);
    }
    if (contaboInstance.cancelDate) {
      instance.cancelDate = new Date(contaboInstance.cancelDate);
    }

    instance.metadata = {
      vHostId: contaboInstance.vHostId,
      vHostName: contaboInstance.vHostName,
      vHostNumber: contaboInstance.vHostNumber,
      tenantId: contaboInstance.tenantId,
      imageId: contaboInstance.imageId,
      productId: contaboInstance.productId,
      errorMessage: contaboInstance.errorMessage,
      sshKeys: contaboInstance.sshKeys,
    };

    return instance;
  }

  private mapContaboStatus(status: string): InstanceStatus {
    switch (status?.toLowerCase()) {
      case 'running':
        return InstanceStatus.RUNNING;
      case 'stopped':
        return InstanceStatus.STOPPED;
      case 'starting':
        return InstanceStatus.STARTING;
      case 'stopping':
        return InstanceStatus.STOPPING;
      case 'provisioning':
        return InstanceStatus.PROVISIONING;
      case 'error':
        return InstanceStatus.ERROR;
      default:
        return InstanceStatus.UNKNOWN;
    }
  }

  async listSSHKeys(): Promise<SSHKeyDto[]> {
    return [];
  }

  async getNodeSizes(): Promise<NodeSizeDto[]> {
    throw new NotImplementedException(
      'Contabo provider: getNodeSizes not yet implemented',
    );
  }

  async getPricing(query: PricingQueryDto): Promise<PricingDto> {
    throw new NotImplementedException(
      'Contabo provider: getPricing not yet implemented',
    );
  }

  private generateSyntheticLabels(serverName: string): Label[] {
    if (!serverName.startsWith(this.FLUI_PREFIX)) {
      return [];
    }

    const parts = serverName.split('-');
    const labels: Label[] = [{ key: 'managed-by', value: 'flui-cloud' }];

    if (parts.length > 2 && parts[1] === 'cluster') {
      labels.push({ key: 'flui-resource-type', value: 'cluster-node' });
      if (parts.length > 4) {
        const clusterName = parts[3];
        const nodeType = parts[4];
        labels.push({ key: 'flui-cluster-name', value: clusterName });
        if (nodeType === 'master' || nodeType === 'worker') {
          labels.push({ key: 'flui-node-type', value: nodeType });
        }
      }
    } else {
      labels.push({ key: 'flui-resource-type', value: 'server' });
    }

    return labels;
  }

  private isFluiManagedByName(serverName: string): boolean {
    return serverName.startsWith(this.FLUI_PREFIX);
  }

  async createSSHKey(
    name: string,
    publicKey: string,
    labels?: Record<string, string>,
  ): Promise<SSHKeyCreationResult> {
    throw new NotImplementedException(
      'Contabo provider: SSH key creation not yet implemented. Configure SSH keys manually in the Contabo dashboard.',
    );
  }

  async deleteSSHKey(providerKeyId: string): Promise<void> {
    this.logger.warn(
      `Contabo provider: SSH key deletion not implemented. Key ${providerKeyId} must be deleted manually from the Contabo dashboard.`,
    );
  }

  async getSSHKey(providerKeyId: string): Promise<SSHKeyDetails> {
    throw new NotImplementedException(
      `Contabo provider: SSH key retrieval not yet implemented. Key ${providerKeyId} details not available.`,
    );
  }

  async updateServerLabels(
    serverId: string,
    labels: Record<string, string>,
  ): Promise<void> {
    this.logger.warn(
      `Contabo provider: label updates not supported. Server ${serverId} labels cannot be updated via API.`,
    );
  }
}
