import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationType,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ClusterAuthzInstallRepository } from '../repositories/cluster-authz-install.repository';
import { ClusterAuthzInstallEntity } from '../entities/cluster-authz-install.entity';
import { AuthzInstallStatus } from '../enums/authz-install-status.enum';
import { InstallAuthzDto } from '../dto/install-authz.dto';

export const AUTHZ_INSTALL_QUEUE = 'authz-install';
export const AUTHZ_INSTALL_JOB = 'install-authz';
export const AUTHZ_UNINSTALL_JOB = 'uninstall-authz';

export interface AuthzInstallJobData {
  installId: string;
  operationId: string;
  /** Re-apply a running install (new release): it stays running meanwhile. */
  refresh?: boolean;
}

export interface AuthzUninstallJobData {
  installId: string;
  operationId: string;
}

@Injectable()
export class AuthzInstallService {
  private readonly logger = new Logger(AuthzInstallService.name);

  constructor(
    @InjectQueue(AUTHZ_INSTALL_QUEUE)
    private readonly queue: Queue,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepo: Repository<InfrastructureOperationEntity>,
    private readonly installRepo: ClusterAuthzInstallRepository,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async install(
    dto: InstallAuthzDto,
    userId?: string,
  ): Promise<{
    install: ClusterAuthzInstallEntity;
    operation: InfrastructureOperationEntity;
  }> {
    const cluster = await this.clusterRepo.findOne({
      where: { id: dto.clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${dto.clusterId} not found`);
    }
    if (cluster.status !== ClusterStatus.READY) {
      throw new BadRequestException(
        `Cluster "${cluster.name}" is not ready (status: ${cluster.status})`,
      );
    }
    if (!cluster.kubeconfigEncrypted) {
      throw new BadRequestException(
        `Cluster "${cluster.name}" has no kubeconfig — ensure it is fully provisioned`,
      );
    }

    const existing = await this.installRepo.findByClusterId(dto.clusterId);
    if (existing?.status === AuthzInstallStatus.INSTALLING) {
      throw new BadRequestException(
        `flui-authz install is already in progress on cluster "${cluster.name}"`,
      );
    }
    const refresh = existing?.status === AuthzInstallStatus.RUNNING;

    const install = refresh
      ? existing
      : await this.installRepo.create({
          clusterId: cluster.id,
          clusterName: cluster.name,
          status: AuthzInstallStatus.PENDING,
          userId,
        });

    const operationSteps = this.buildInstallSteps();
    const operation = await this.operationRepo.save(
      this.operationRepo.create({
        operationType: OperationType.INSTALL_AUTHZ,
        status: OperationStatus.PENDING,
        resourceType: 'authz-install',
        resourceName: `flui-authz@${cluster.name}`,
        resourceId: install.id,
        userId,
        totalSteps: operationSteps.length,
        currentStepIndex: 0,
        currentStepProgress: 0,
        metadata: {
          installId: install.id,
          clusterId: cluster.id,
          operationSteps,
        },
      }),
    );

    await this.installRepo.update(install.id, { operationId: operation.id });
    install.operationId = operation.id;

    const jobData: AuthzInstallJobData = {
      installId: install.id,
      operationId: operation.id,
      ...(refresh ? { refresh } : {}),
    };
    await this.queue.add(AUTHZ_INSTALL_JOB, jobData, {
      attempts: 1,
      timeout: 10 * 60 * 1000,
    });

    this.logger.log(
      `Queued authz install on cluster ${cluster.name} (${cluster.id})`,
    );
    return { install, operation };
  }

  async uninstall(
    installId: string,
    userId?: string,
  ): Promise<{
    install: ClusterAuthzInstallEntity;
    operation: InfrastructureOperationEntity;
  }> {
    const install = await this.installRepo.findById(installId);
    if (!install) {
      throw new NotFoundException(`Authz install ${installId} not found`);
    }
    if (install.status === AuthzInstallStatus.UNINSTALLED) {
      throw new BadRequestException('Already uninstalled');
    }

    const operation = await this.operationRepo.save(
      this.operationRepo.create({
        operationType: OperationType.UNINSTALL_AUTHZ,
        status: OperationStatus.PENDING,
        resourceType: 'authz-install',
        resourceName: `flui-authz@${install.clusterName}`,
        resourceId: install.id,
        userId,
        totalSteps: 3,
        currentStepIndex: 0,
        metadata: { installId: install.id, clusterId: install.clusterId },
      }),
    );

    const jobData: AuthzUninstallJobData = {
      installId: install.id,
      operationId: operation.id,
    };
    await this.queue.add(AUTHZ_UNINSTALL_JOB, jobData, {
      attempts: 1,
      timeout: 5 * 60 * 1000,
    });

    this.logger.log(`Queued authz uninstall for install ${installId}`);
    return { install, operation };
  }

  async findAll(): Promise<ClusterAuthzInstallEntity[]> {
    return this.installRepo.findAll();
  }

  async findOne(id: string): Promise<ClusterAuthzInstallEntity> {
    const install = await this.installRepo.findById(id);
    if (!install) throw new NotFoundException(`Authz install ${id} not found`);
    return install;
  }

  private buildInstallSteps() {
    return [
      {
        step: OperationStep.AUTHZ_INSTALL_INIT,
        label: 'Initializing',
        weight: 10,
      },
      {
        step: OperationStep.AUTHZ_ENSURE_NAMESPACE,
        label: 'Ensuring flui-system namespace',
        weight: 10,
      },
      {
        step: OperationStep.AUTHZ_DEPLOY_SERVICE,
        label: 'Applying Service',
        weight: 15,
      },
      {
        step: OperationStep.AUTHZ_DEPLOY_WORKLOAD,
        label: 'Applying Deployment',
        weight: 25,
      },
      {
        step: OperationStep.AUTHZ_WAIT_READY,
        label: 'Waiting for pod readiness',
        weight: 30,
      },
      {
        step: OperationStep.AUTHZ_INSTALL_FINALIZE,
        label: 'Finalizing',
        weight: 10,
      },
    ];
  }
}
