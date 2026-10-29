import { Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  CNPG_DEPLOYMENT,
  CNPG_MANIFEST_URL,
  CNPG_NAMESPACE,
  CNPG_VERSION,
} from '../postgres-ha.constants';
import { cnpgOperatorPlacement } from '../utils/cnpg-operator-placement.core';

const READY_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;

/**
 * Installs the CloudNativePG operator on a cluster the first time an
 * application asks for a highly available Postgres, and never before: a
 * cluster where nobody asks for one carries nothing of it.
 *
 * Applied server-side, as the project requires: its resource definitions are
 * too large for the annotation a client-side apply writes.
 */
@Injectable()
export class CnpgOperatorInstallerService {
  private readonly logger = new Logger(CnpgOperatorInstallerService.name);
  private manifestCache: string | null = null;

  constructor(private readonly kubernetesService: KubernetesService) {}

  async isInstalled(kubeconfig: string): Promise<boolean> {
    const existing = await this.kubernetesService.getResource(
      kubeconfig,
      'Deployment',
      CNPG_DEPLOYMENT,
      CNPG_NAMESPACE,
    );
    return Boolean(existing);
  }

  async ensureInstalled(kubeconfig: string): Promise<void> {
    if (!(await this.isInstalled(kubeconfig))) {
      this.logger.log(`Installing CloudNativePG ${CNPG_VERSION}`);
      const applied = await this.kubernetesService.serverSideApply(
        kubeconfig,
        await this.fetchManifest(),
      );
      this.logger.log(`CloudNativePG: ${applied} objects applied`);
    }
    await this.kubernetesService.mergePatchObject(
      kubeconfig,
      cnpgOperatorPlacement(),
    );
    await this.waitReady(kubeconfig);
    this.logger.log(`CloudNativePG ${CNPG_VERSION} ready`);
  }

  private async fetchManifest(): Promise<string> {
    if (this.manifestCache) return this.manifestCache;
    const response = await fetch(CNPG_MANIFEST_URL);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch the CloudNativePG manifest from ${CNPG_MANIFEST_URL}: ${response.status} ${response.statusText}`,
      );
    }
    this.manifestCache = await response.text();
    return this.manifestCache;
  }

  private async waitReady(kubeconfig: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < READY_TIMEOUT_MS) {
      const resource = await this.kubernetesService.getResource(
        kubeconfig,
        'Deployment',
        CNPG_DEPLOYMENT,
        CNPG_NAMESPACE,
      );
      const body = resource?.body ?? resource;
      if ((body?.status?.availableReplicas ?? 0) >= 1) return;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(
      `CloudNativePG did not become ready within ${READY_TIMEOUT_MS / 1000}s`,
    );
  }
}
