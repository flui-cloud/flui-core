import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Raw, Repository } from 'typeorm';
import * as Handlebars from 'handlebars';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../clusters/entities/cluster.entity';
import {
  K3S_DEFAULT_VERSION,
  FLUI_CONTROL_NAMESPACE,
  FLUI_LEGACY_CONTROL_NAMESPACE,
} from '../clusters/constants';
import { ClustersService } from '../clusters/clusters.service';
import { KubernetesService } from '../shared/services/kubernetes.service';
import { GrafanaDatasourceService } from 'src/modules/grafana/services/grafana-datasource.service';
import { RELEASE } from 'src/config/release.config';

export interface ObservabilityEndpoints {
  prometheus?: string;
  loki?: string;
  grafana?: string;
  postgres?: string;
  redis?: string;
  fluiApi?: string;
}

export interface ObservabilityStackConfig {
  postgresPassword: string;
  redisPassword: string;
  grafanaPassword: string;
  fluiApiImage: string;
  storageSize?: string;
}

@Injectable()
export class ControlClusterService {
  private readonly logger = new Logger(ControlClusterService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly clustersService: ClustersService,
    private readonly kubernetesService: KubernetesService,
    private readonly grafanaDatasourceService: GrafanaDatasourceService,
  ) {}

  /**
   * Create control cluster
   */
  async createControlCluster(
    provider: string,
    region: string,
    nodeSize: string,
    workerCount: number = 0,
  ): Promise<string> {
    this.logger.log('Creating control cluster...');

    // Check if control cluster already exists
    // Use getControlCluster() for consistent lookup logic
    const existing = await this.getControlCluster();

    if (existing && existing.status !== ClusterStatus.DELETED) {
      throw new Error(
        'Control cluster already exists. Delete it first before creating a new one.',
      );
    }

    // Create cluster via ClustersService (returns operation, not cluster)
    const operation = await this.clustersService.createCluster({
      name: 'control-cluster',
      provider: provider as any, // CloudProvider enum
      region,
      nodeSize,
      workerCount,
      k3sVersion: K3S_DEFAULT_VERSION,
      metadata: {
        purpose: 'control',
        isControlCluster: true,
      },
    });

    this.logger.log(
      `Control cluster creation started: operation ${operation.id}`,
    );
    // Return the cluster ID from operation metadata or resourceId
    return operation.resourceId || operation.metadata?.clusterId;
  }

  /**
   * Deploy observability stack to cluster
   */
  async deployObservabilityStack(
    clusterId: string,
    config?: Partial<ObservabilityStackConfig>,
  ): Promise<ObservabilityEndpoints> {
    this.logger.log(`Deploying observability stack to cluster ${clusterId}...`);

    // Get cluster
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    if (cluster.status !== ClusterStatus.READY) {
      throw new Error(
        `Cluster ${clusterId} is not ready. Current status: ${cluster.status}`,
      );
    }

    // Get kubeconfig
    const kubeconfig = await this.clustersService.getKubeconfig(clusterId);
    if (!kubeconfig) {
      throw new Error(`Kubeconfig not available for cluster ${clusterId}`);
    }

    // Generate passwords if not provided
    const stackConfig: ObservabilityStackConfig = {
      postgresPassword:
        config?.postgresPassword || this.generateSecurePassword(),
      redisPassword: config?.redisPassword || this.generateSecurePassword(),
      grafanaPassword: config?.grafanaPassword || this.generateSecurePassword(),
      fluiApiImage:
        config?.fluiApiImage ||
        `ghcr.io/flui-cloud/core:${RELEASE.images.fluiApi}`,
      storageSize: config?.storageSize || '10Gi',
    };

    this.logger.log('Stack configuration prepared');

    // Deploy manifests in order
    const manifests = [
      'namespace',
      'postgres',
      'redis',
      'prometheus',
      'loki',
      'grafana',
      // 'flui-api', // Skip for now, will be added in future
    ];

    for (const manifestName of manifests) {
      this.logger.log(`Deploying ${manifestName}...`);
      const yaml = this.renderTemplate(manifestName, stackConfig);
      await this.kubernetesService.applyManifest(kubeconfig, yaml);
      this.logger.log(`${manifestName} deployed successfully`);
    }

    // Wait for all pods to be ready
    await this.waitForStackReady(kubeconfig);

    // Get public endpoints
    const endpoints = await this.getObservabilityEndpoints(
      clusterId,
      kubeconfig,
    );

    // Update cluster metadata with endpoints and passwords
    cluster.metadata = {
      ...cluster.metadata,
      observabilityStack: {
        deployed: true,
        deployedAt: new Date().toISOString(),
        endpoints,
        passwords: {
          postgres: stackConfig.postgresPassword,
          redis: stackConfig.redisPassword,
          grafana: stackConfig.grafanaPassword,
        },
      },
    };
    await this.clusterRepository.save(cluster);

    // Create centralized Loki datasource in Grafana
    // This datasource is shared across all workload clusters
    try {
      await this.grafanaDatasourceService.createCentralizedLokiDatasource();
      this.logger.log('Centralized Loki datasource created in Grafana');
    } catch (error) {
      this.logger.warn(
        `Failed to create centralized Loki datasource: ${error.message}`,
      );
      // Don't fail the deployment if Grafana datasource creation fails
      // The stack is still functional without it
    }

    this.logger.log('Observability stack deployed successfully');
    return endpoints;
  }

  /**
   * Get observability endpoints
   */
  async getObservabilityEndpoints(
    clusterId: string,
    kubeconfigContent?: string,
  ): Promise<ObservabilityEndpoints> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const kubeconfig =
      kubeconfigContent ||
      (await this.clustersService.getKubeconfig(clusterId));
    if (!kubeconfig) {
      throw new Error(`Kubeconfig not available for cluster ${clusterId}`);
    }

    // Get NodePort services
    const prometheusService = await this.getControlNamespaceResource(
      kubeconfig,
      'Service',
      'prometheus',
    );
    const grafanaService = await this.getControlNamespaceResource(
      kubeconfig,
      'Service',
      'grafana',
    );
    const lokiService = await this.getControlNamespaceResource(
      kubeconfig,
      'Service',
      'loki',
    );
    const postgresService = await this.kubernetesService.getResource(
      kubeconfig,
      'Service',
      'postgres',
      'flui-system',
    );
    const redisService = await this.kubernetesService.getResource(
      kubeconfig,
      'Service',
      'redis',
      'flui-system',
    );

    const masterIp = cluster.masterPrivateIp ?? cluster.masterIpAddress;
    const endpoints: ObservabilityEndpoints = {};

    if (prometheusService && masterIp) {
      const prometheusNodePort = prometheusService.spec?.ports?.[0]?.nodePort;
      if (prometheusNodePort) {
        endpoints.prometheus = `http://${masterIp}:${prometheusNodePort}`;
      }
    }

    if (grafanaService && masterIp) {
      const grafanaNodePort = grafanaService.spec?.ports?.[0]?.nodePort;
      if (grafanaNodePort) {
        endpoints.grafana = `http://${masterIp}:${grafanaNodePort}`;
      }
    }

    if (lokiService && masterIp) {
      const lokiNodePort = lokiService.spec?.ports?.[0]?.nodePort;
      if (lokiNodePort) {
        endpoints.loki = `http://${masterIp}:${lokiNodePort}`;
      }
    }

    if (postgresService && masterIp) {
      const postgresNodePort = postgresService.spec?.ports?.[0]?.nodePort;
      if (postgresNodePort) {
        endpoints.postgres = `http://${masterIp}:${postgresNodePort}`;
      }
    }

    if (redisService && masterIp) {
      const redisNodePort = redisService.spec?.ports?.[0]?.nodePort;
      if (redisNodePort) {
        endpoints.redis = `http://${masterIp}:${redisNodePort}`;
      }
    }

    return endpoints;
  }

  /**
   * Delete control cluster
   */
  async deleteControlCluster(clusterId: string): Promise<void> {
    this.logger.log(`Deleting control cluster ${clusterId}...`);

    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const purpose = cluster.metadata?.purpose;
    if (purpose !== 'control' && purpose !== 'observability') {
      throw new Error(`Cluster ${clusterId} is not a control cluster`);
    }

    await this.clustersService.deleteCluster(clusterId);
    this.logger.log(`Control cluster ${clusterId} deleted`);
  }

  /**
   * Get the control cluster (accepts both the new and legacy enum/metadata values).
   */
  async getControlCluster(): Promise<ClusterEntity | null> {
    // First try to find by clusterType (new + legacy values)
    const clusterByType = await this.clusterRepository.findOne({
      where: [
        { clusterType: ClusterType.CONTROL },
        { clusterType: ClusterType.OBSERVABILITY },
      ],
      relations: ['nodes'],
    });

    if (clusterByType) {
      return clusterByType;
    }

    // Fallback to legacy metadata.purpose for backward compatibility
    return await this.clusterRepository.findOne({
      where: {
        metadata: Raw(
          (alias) => `${alias} ->> 'purpose' IN ('control', 'observability')`,
        ),
      },
      relations: ['nodes'],
    });
  }

  // Private helper methods

  /**
   * Reads a resource from the control cluster's observability namespace, trying the
   * current namespace first and falling back to the legacy one for older clusters.
   */
  private async getControlNamespaceResource(
    kubeconfig: string,
    kind: string,
    name: string,
  ): Promise<any> {
    const current = await this.kubernetesService.getResource(
      kubeconfig,
      kind,
      name,
      FLUI_CONTROL_NAMESPACE,
    );
    if (current) {
      return current;
    }
    return this.kubernetesService.getResource(
      kubeconfig,
      kind,
      name,
      FLUI_LEGACY_CONTROL_NAMESPACE,
    );
  }

  private renderTemplate(
    templateName: string,
    config: ObservabilityStackConfig,
  ): string {
    const templatePath = path.join(
      process.cwd(),
      'cli',
      'templates',
      'k8s',
      `${templateName}.yaml.hbs`,
    );

    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template not found: ${templatePath}`);
    }

    const templateContent = fs.readFileSync(templatePath, 'utf-8');
    const template = Handlebars.compile(templateContent);
    return template(config);
  }

  private generateSecurePassword(length: number = 32): string {
    return crypto.randomBytes(length).toString('base64').slice(0, length);
  }

  private async waitForStackReady(kubeconfig: string): Promise<void> {
    this.logger.log('Waiting for stack to be ready...');

    const resources = [
      { kind: 'StatefulSet', name: 'postgres', namespace: 'flui-system' },
      { kind: 'Deployment', name: 'redis', namespace: 'flui-system' },
      {
        kind: 'Deployment',
        name: 'prometheus',
        namespace: FLUI_CONTROL_NAMESPACE,
      },
      { kind: 'Deployment', name: 'loki', namespace: FLUI_CONTROL_NAMESPACE },
      {
        kind: 'Deployment',
        name: 'grafana',
        namespace: FLUI_CONTROL_NAMESPACE,
      },
    ];

    for (const resource of resources) {
      try {
        this.logger.log(
          `Waiting for ${resource.kind}/${resource.name} to be ready...`,
        );
        await this.kubernetesService.waitForReady(
          kubeconfig,
          resource.kind,
          resource.name,
          resource.namespace,
          600000, // 10 minutes timeout
        );
        this.logger.log(`${resource.kind}/${resource.name} is ready`);
      } catch (error) {
        this.logger.error(
          `Failed to wait for ${resource.kind}/${resource.name}: ${error.message}`,
        );
        throw error;
      }
    }

    this.logger.log('All stack components are ready');
  }
}
