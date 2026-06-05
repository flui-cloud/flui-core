import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SystemAppCatalogService } from '../../applications/services/system-app-catalog.service';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  ClusterEntity,
  ClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ClusterAuthzInstallRepository } from '../repositories/cluster-authz-install.repository';
import { AuthzInstallStatus } from '../enums/authz-install-status.enum';
import {
  AUTHZ_INSTALL_QUEUE,
  AUTHZ_INSTALL_JOB,
  AUTHZ_UNINSTALL_JOB,
  AuthzInstallJobData,
  AuthzUninstallJobData,
} from '../services/authz-install.service';
import { RELEASE } from 'src/config/release.config';

// FLUI_AUTHZ_IMAGE_TAG is injected into the API env by the control-cluster
// bootstrap (pinned to the install's release); the release pin is the fallback
// when that env is absent.
const FLUI_AUTHZ_IMAGE = `ghcr.io/flui-cloud/flui-authz:${process.env.FLUI_AUTHZ_IMAGE_TAG ?? RELEASE.images.fluiAuthz}`;
const FLUI_SYSTEM_NS = 'flui-system';
const AUTHZ_DEPLOYMENT_NAME = 'flui-authz';
const AUTHZ_SERVICE_NAME = 'flui-authz';
const READY_POLL_INTERVAL_MS = 5_000;
const READY_TIMEOUT_MS = 5 * 60 * 1_000;

@Processor(AUTHZ_INSTALL_QUEUE)
export class AuthzInstallProcessor {
  private readonly logger = new Logger(AuthzInstallProcessor.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepo: Repository<InfrastructureOperationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    private readonly installRepo: ClusterAuthzInstallRepository,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly systemAppCatalog: SystemAppCatalogService,
  ) {}

  @Process(AUTHZ_INSTALL_JOB)
  async handleInstall(job: Job<AuthzInstallJobData>): Promise<void> {
    const { installId, operationId } = job.data;
    this.logger.log(`[authz-install] Starting install ${installId}`);

    const step = async (s: OperationStep, progress: number) => {
      await this.operationRepo.update(operationId, {
        currentStep: s,
        progress,
        status: OperationStatus.IN_PROGRESS,
        startedAt: progress === 10 ? new Date() : undefined,
      });
    };

    try {
      await step(OperationStep.AUTHZ_INSTALL_INIT, 10);
      const install = await this.installRepo.findById(installId);
      const cluster = await this.clusterRepo.findOne({
        where: { id: install.clusterId },
      });
      const kubeconfig = this.encryptionService.decrypt(
        cluster.kubeconfigEncrypted,
      );

      await this.installRepo.update(installId, {
        status: AuthzInstallStatus.INSTALLING,
      });

      // Read OIDC config from control cluster
      const { jwksUri, audience, issuer, dashboardUrl } =
        await this.readOidcConfig();

      await step(OperationStep.AUTHZ_ENSURE_NAMESPACE, 20);
      await this.kubernetesService.applyManifest(
        kubeconfig,
        this.buildNamespaceManifest(),
      );

      await step(OperationStep.AUTHZ_DEPLOY_SERVICE, 30);
      await this.kubernetesService.applyManifest(
        kubeconfig,
        this.buildServiceManifest(),
      );

      await step(OperationStep.AUTHZ_DEPLOY_WORKLOAD, 45);
      await this.kubernetesService.applyManifest(
        kubeconfig,
        this.buildDeploymentManifest(jwksUri, audience, issuer, dashboardUrl),
      );

      await step(OperationStep.AUTHZ_WAIT_READY, 70);
      await this.waitForReady(kubeconfig);

      await step(OperationStep.AUTHZ_INSTALL_FINALIZE, 95);
      await this.installRepo.update(installId, {
        status: AuthzInstallStatus.RUNNING,
        installedAt: new Date(),
        errorMessage: undefined,
      });

      try {
        await this.systemAppCatalog.discoverSystemApps(cluster.id);
      } catch (e) {
        this.logger.warn(
          `[authz-install] System app discovery failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      await this.operationRepo.update(operationId, {
        status: OperationStatus.COMPLETED,
        progress: 100,
        completedAt: new Date(),
      });
      this.logger.log(
        `[authz-install] Completed install ${installId} on cluster ${cluster.name}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[authz-install] Failed install ${installId}: ${msg}`);
      await this.installRepo.update(installId, {
        status: AuthzInstallStatus.FAILED,
        errorMessage: msg,
      });
      await this.operationRepo.update(operationId, {
        status: OperationStatus.FAILED,
        errorMessage: msg,
        completedAt: new Date(),
      });
      throw err;
    }
  }

  @Process(AUTHZ_UNINSTALL_JOB)
  async handleUninstall(job: Job<AuthzUninstallJobData>): Promise<void> {
    const { installId, operationId } = job.data;
    this.logger.log(`[authz-uninstall] Starting uninstall ${installId}`);

    try {
      await this.operationRepo.update(operationId, {
        currentStep: OperationStep.AUTHZ_UNINSTALL_INIT,
        status: OperationStatus.IN_PROGRESS,
        startedAt: new Date(),
        progress: 20,
      });

      const install = await this.installRepo.findById(installId);
      const cluster = await this.clusterRepo.findOne({
        where: { id: install.clusterId },
      });
      const kubeconfig = this.encryptionService.decrypt(
        cluster.kubeconfigEncrypted,
      );

      await this.operationRepo.update(operationId, {
        currentStep: OperationStep.AUTHZ_UNINSTALL_DELETE_WORKLOAD,
        progress: 50,
      });

      await this.kubernetesService
        .deleteResource(
          kubeconfig,
          'Deployment',
          AUTHZ_DEPLOYMENT_NAME,
          FLUI_SYSTEM_NS,
        )
        .catch(() => {});
      await this.kubernetesService
        .deleteResource(
          kubeconfig,
          'Service',
          AUTHZ_SERVICE_NAME,
          FLUI_SYSTEM_NS,
        )
        .catch(() => {});

      await this.operationRepo.update(operationId, {
        currentStep: OperationStep.AUTHZ_UNINSTALL_FINALIZE,
        progress: 90,
      });

      await this.installRepo.update(installId, {
        status: AuthzInstallStatus.UNINSTALLED,
      });
      await this.operationRepo.update(operationId, {
        status: OperationStatus.COMPLETED,
        progress: 100,
        completedAt: new Date(),
      });
      this.logger.log(`[authz-uninstall] Completed uninstall ${installId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[authz-uninstall] Failed uninstall ${installId}: ${msg}`,
      );
      await this.operationRepo.update(operationId, {
        status: OperationStatus.FAILED,
        errorMessage: msg,
        completedAt: new Date(),
      });
      throw err;
    }
  }

  private async readOidcConfig(): Promise<{
    jwksUri: string;
    audience: string;
    issuer: string;
    dashboardUrl: string;
  }> {
    const obsCluster = await this.clusterRepo.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
    });
    if (!obsCluster?.kubeconfigEncrypted) {
      throw new Error('Control cluster not found — cannot read OIDC config');
    }
    const kubeconfig = this.encryptionService.decrypt(
      obsCluster.kubeconfigEncrypted,
    );

    let authMode = 'unknown';
    let jwksUri = '';
    let issuer = '';
    try {
      const cm = await this.kubernetesService.getResource(
        kubeconfig,
        'ConfigMap',
        'flui-api-config',
        FLUI_SYSTEM_NS,
      );
      const data = (cm?.body ?? cm)?.data ?? {};
      authMode = data['AUTH_MODE'] ?? 'unknown';
      issuer = data['OIDC_ISSUER'] ?? '';
      jwksUri = data['OIDC_JWKS_URI'] ?? '';
    } catch {
      /* leave defaults */
    }
    if (authMode !== 'oidc') {
      throw new Error(
        `Platform auth mode is "${authMode}", not "oidc" — cannot install flui-authz`,
      );
    }

    let audience = '';
    try {
      const secret = await this.kubernetesService.getResource(
        kubeconfig,
        'Secret',
        'flui-secrets',
        FLUI_SYSTEM_NS,
      );
      const secretData = (secret?.body ?? secret)?.data ?? {};
      const raw = secretData['OIDC_AUDIENCE'];
      if (raw) audience = Buffer.from(raw, 'base64').toString('utf-8');
    } catch {
      /* leave empty */
    }

    let dashboardUrl = (
      process.env.PUBLIC_WEB_URL ||
      process.env.DASHBOARD_URL ||
      ''
    ).replace(/\/+$/, '');

    if (!dashboardUrl) {
      try {
        const ingress = await this.kubernetesService.getResource(
          kubeconfig,
          'Ingress',
          'flui-web-ingress',
          FLUI_SYSTEM_NS,
        );
        const host = (ingress?.body ?? ingress)?.spec?.rules?.[0]?.host;
        if (host) dashboardUrl = `https://${host}`;
      } catch {
        /* leave empty — flui-authz will still work, redirect just won't point to dashboard */
      }
    }

    // Fail fast — installing with an invalid JWKS URI produces an auth-deny loop later.
    if (!jwksUri) {
      if (!issuer) {
        throw new Error(
          'Cannot resolve OIDC JWKS URI: neither OIDC_JWKS_URI nor OIDC_ISSUER is set in flui-api-config. ' +
            'Wait for OidcBootstrapService to populate these and retry.',
        );
      }
      jwksUri = `${issuer.replace(/\/+$/, '')}/oauth/v2/keys`;
    }

    return { jwksUri, audience, issuer, dashboardUrl };
  }

  private buildNamespaceManifest(): string {
    return JSON.stringify({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: FLUI_SYSTEM_NS,
        labels: { 'managed-by': 'flui-cloud' },
      },
    });
  }

  private buildServiceManifest(): string {
    return JSON.stringify({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: AUTHZ_SERVICE_NAME,
        namespace: FLUI_SYSTEM_NS,
        labels: { 'managed-by': 'flui-cloud', 'flui-resource-type': 'authz' },
      },
      spec: {
        selector: { app: 'flui-authz' },
        ports: [{ port: 80, targetPort: 8080 }],
      },
    });
  }

  private buildDeploymentManifest(
    jwksUri: string,
    audience: string,
    issuer: string,
    dashboardUrl: string,
  ): string {
    return JSON.stringify({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: AUTHZ_DEPLOYMENT_NAME,
        namespace: FLUI_SYSTEM_NS,
        labels: { 'managed-by': 'flui-cloud', 'flui-resource-type': 'authz' },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'flui-authz' } },
        template: {
          metadata: { labels: { app: 'flui-authz' } },
          spec: {
            containers: [
              {
                name: 'flui-authz',
                image: FLUI_AUTHZ_IMAGE,
                ports: [{ containerPort: 8080 }],
                env: [
                  { name: 'OIDC_JWKS_URI', value: jwksUri },
                  { name: 'OIDC_AUDIENCE', value: audience },
                  { name: 'OIDC_ISSUER', value: issuer },
                  { name: 'DASHBOARD_URL', value: dashboardUrl },
                  { name: 'PORT', value: '8080' },
                ],
                readinessProbe: {
                  httpGet: { path: '/healthz', port: 8080 },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                },
              },
            ],
          },
        },
      },
    });
  }

  private async waitForReady(kubeconfig: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const dep = await this.kubernetesService.getResource(
          kubeconfig,
          'Deployment',
          AUTHZ_DEPLOYMENT_NAME,
          FLUI_SYSTEM_NS,
        );
        const status = (dep?.body ?? dep)?.status ?? {};
        if ((status.readyReplicas ?? 0) >= 1) return;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
    }
    throw new Error(
      `flui-authz Deployment did not become ready within ${READY_TIMEOUT_MS / 1000}s`,
    );
  }
}
