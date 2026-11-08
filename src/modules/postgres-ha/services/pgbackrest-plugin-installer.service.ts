import { Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { CNPG_NAMESPACE } from '../postgres-ha.constants';
import {
  PGBACKREST_PLUGIN_DEPLOYMENT,
  PGBACKREST_PLUGIN_MANIFEST_URL,
  pinnedPgbackrestPluginManifest,
} from '../utils/pgbackrest-plugin.core';

const READY_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;

/**
 * Installs the pgBackRest plugin beside CloudNativePG the first time a highly
 * available database is backed up, and never before. Its controller and the
 * operator talk over TLS that cert-manager issues, which every Flui cluster
 * has from its first boot.
 */
@Injectable()
export class PgbackrestPluginInstallerService {
  private readonly logger = new Logger(PgbackrestPluginInstallerService.name);
  private manifestCache: string | null = null;

  constructor(private readonly kubernetesService: KubernetesService) {}

  async ensureInstalled(kubeconfig: string): Promise<void> {
    const existing = await this.kubernetesService.getResource(
      kubeconfig,
      'Deployment',
      PGBACKREST_PLUGIN_DEPLOYMENT,
      CNPG_NAMESPACE,
    );
    if (!existing) {
      const issuerKind = await this.kubernetesService
        .readObject(
          kubeconfig,
          'apiextensions.k8s.io/v1',
          'CustomResourceDefinition',
          'issuers.cert-manager.io',
        )
        .catch(() => null);
      if (!issuerKind) {
        throw new Error(
          'This cluster has no cert-manager, which the backup of a highly available database needs to secure its components.',
        );
      }
      this.logger.log('Installing the pgBackRest plugin for CloudNativePG');
      const applied = await this.kubernetesService.serverSideApply(
        kubeconfig,
        await this.fetchManifest(),
      );
      this.logger.log(`pgBackRest plugin: ${applied} objects applied`);
    }
    await this.waitReady(kubeconfig);
  }

  private async fetchManifest(): Promise<string> {
    if (this.manifestCache) return this.manifestCache;
    const response = await fetch(PGBACKREST_PLUGIN_MANIFEST_URL);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch the pgBackRest plugin manifest from ${PGBACKREST_PLUGIN_MANIFEST_URL}: ${response.status} ${response.statusText}`,
      );
    }
    this.manifestCache = pinnedPgbackrestPluginManifest(await response.text());
    return this.manifestCache;
  }

  private async waitReady(kubeconfig: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < READY_TIMEOUT_MS) {
      const resource = await this.kubernetesService.getResource(
        kubeconfig,
        'Deployment',
        PGBACKREST_PLUGIN_DEPLOYMENT,
        CNPG_NAMESPACE,
      );
      const body = resource?.body ?? resource;
      if ((body?.status?.availableReplicas ?? 0) >= 1) return;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(
      `The pgBackRest plugin did not become ready within ${READY_TIMEOUT_MS / 1000}s`,
    );
  }
}
