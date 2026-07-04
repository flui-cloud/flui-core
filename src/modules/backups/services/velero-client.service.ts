import { Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { TemplateRendererService } from './template-renderer.service';
import {
  VELERO_NAMESPACE,
  VELERO_BACKUP_POLL_INTERVAL_MS,
  VELERO_BACKUP_POLL_TIMEOUT_MS,
} from '../backups.constants';

export interface CreateVeleroBackupSpec {
  backupName: string;
  policyId?: string;
  jobId: string;
  bslName: string;
  ttlHours: number;
  includedNamespaces: string[];
  includePvcs: boolean;
  labelSelector?: Record<string, string>;
  extraLabels?: Record<string, string>;
}

export interface CreateVeleroRestoreSpec {
  restoreName: string;
  restoreJobId: string;
  backupName: string;
  includedNamespaces?: string[];
  namespaceMapping?: Record<string, string>;
  labelSelector?: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// FailedValidation is terminal too (bad BSL/creds/region, or the backup not yet
// synced on the target). Omitting it makes the waiters spin for the full poll
// timeout and surface a misleading "did not complete" instead of the real error.
const TERMINAL_VELERO_PHASES = new Set([
  'Completed',
  'PartiallyFailed',
  'Failed',
  'FailedValidation',
]);

@Injectable()
export class VeleroClientService {
  private readonly logger = new Logger(VeleroClientService.name);

  constructor(
    private readonly k8s: KubernetesService,
    private readonly templates: TemplateRendererService,
  ) {}

  private formatLabels(labels: Record<string, string>, indent = 4): string {
    const pad = ' '.repeat(indent);
    return Object.entries(labels)
      .map(([k, v]) => `${pad}${k}: "${v}"`)
      .join('\n');
  }

  private formatList(items: string[], indent = 4): string {
    const pad = ' '.repeat(indent);
    if (!items.length) return `${pad}[]`;
    return items.map((i) => `${pad}- "${i}"`).join('\n');
  }

  async createBackup(
    kubeconfig: string,
    spec: CreateVeleroBackupSpec,
  ): Promise<void> {
    const labelSelectorBlock = spec.labelSelector
      ? `  labelSelector:\n    matchLabels:\n${this.formatLabels(spec.labelSelector, 6)}`
      : '';
    const extraLabelsBlock = spec.extraLabels
      ? this.formatLabels(spec.extraLabels, 4)
      : '';
    const yaml = this.templates.render('velero/velero-backup.yaml.tpl', {
      BACKUP_NAME: spec.backupName,
      NAMESPACE: VELERO_NAMESPACE,
      POLICY_ID: spec.policyId ?? '',
      JOB_ID: spec.jobId,
      BSL_NAME: spec.bslName,
      INCLUDE_PVCS: String(spec.includePvcs),
      TTL: `${spec.ttlHours}h0m0s`,
      INCLUDED_NAMESPACES_BLOCK: this.formatList(spec.includedNamespaces, 4),
      LABEL_SELECTOR_BLOCK: labelSelectorBlock,
      EXTRA_LABELS_BLOCK: extraLabelsBlock,
    });
    await this.k8s.applyManifest(kubeconfig, yaml);
  }

  async createRestore(
    kubeconfig: string,
    spec: CreateVeleroRestoreSpec,
  ): Promise<void> {
    const includedNs = spec.includedNamespaces?.length
      ? `  includedNamespaces:\n${this.formatList(spec.includedNamespaces, 4)}`
      : '';
    const namespaceMapping = spec.namespaceMapping
      ? `  namespaceMapping:\n${Object.entries(spec.namespaceMapping)
          .map(([k, v]) => `    ${k}: ${v}`)
          .join('\n')}`
      : '';
    const labelSelectorBlock = spec.labelSelector
      ? `  labelSelector:\n    matchLabels:\n${this.formatLabels(spec.labelSelector, 6)}`
      : '';
    const yaml = this.templates.render('velero/velero-restore.yaml.tpl', {
      RESTORE_NAME: spec.restoreName,
      NAMESPACE: VELERO_NAMESPACE,
      RESTORE_JOB_ID: spec.restoreJobId,
      BACKUP_NAME: spec.backupName,
      NAMESPACE_MAPPING_BLOCK: namespaceMapping,
      INCLUDED_NAMESPACES_BLOCK: includedNs,
      LABEL_SELECTOR_BLOCK: labelSelectorBlock,
    });
    await this.k8s.applyManifest(kubeconfig, yaml);
  }

  async getBackup(kubeconfig: string, name: string): Promise<any | null> {
    return this.k8s.getResource(kubeconfig, 'Backup', name, VELERO_NAMESPACE);
  }

  async getRestore(kubeconfig: string, name: string): Promise<any | null> {
    return this.k8s.getResource(kubeconfig, 'Restore', name, VELERO_NAMESPACE);
  }

  async waitForBackup(
    kubeconfig: string,
    name: string,
    timeoutMs: number = VELERO_BACKUP_POLL_TIMEOUT_MS,
  ): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const obj: any = await this.getBackup(kubeconfig, name);
      const phase = obj?.body?.status?.phase ?? obj?.status?.phase;
      if (phase && TERMINAL_VELERO_PHASES.has(phase)) {
        return obj?.body ?? obj;
      }
      await sleep(VELERO_BACKUP_POLL_INTERVAL_MS);
    }
    throw new Error(`Velero Backup ${name} did not complete within timeout`);
  }

  async waitForRestore(
    kubeconfig: string,
    name: string,
    timeoutMs: number = VELERO_BACKUP_POLL_TIMEOUT_MS,
  ): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const obj: any = await this.getRestore(kubeconfig, name);
      const phase = obj?.body?.status?.phase ?? obj?.status?.phase;
      if (phase && TERMINAL_VELERO_PHASES.has(phase)) {
        return obj?.body ?? obj;
      }
      await sleep(VELERO_BACKUP_POLL_INTERVAL_MS);
    }
    throw new Error(`Velero Restore ${name} did not complete within timeout`);
  }

  async waitForBackupSynced(
    kubeconfig: string,
    name: string,
    timeoutMs: number = 3 * 60 * 1000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const obj = await this.getBackup(kubeconfig, name);
      if (obj) return;
      await sleep(VELERO_BACKUP_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Velero Backup ${name} was not synced to the target cluster within ${timeoutMs}ms`,
    );
  }

  async waitForStorageLocationAvailable(
    kubeconfig: string,
    bslName: string,
    timeoutMs: number = 3 * 60 * 1000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const obj = await this.k8s.getResource(
        kubeconfig,
        'BackupStorageLocation',
        bslName,
        VELERO_NAMESPACE,
      );
      const phase = obj?.body?.status?.phase ?? obj?.status?.phase;
      if (phase === 'Available') return;
      await sleep(VELERO_BACKUP_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Velero BackupStorageLocation ${bslName} did not become Available within ${timeoutMs}ms`,
    );
  }

  async listFailedPodVolumeBackups(
    kubeconfig: string,
    backupName: string,
  ): Promise<string[]> {
    const items = await this.k8s.listResourcesByLabel(
      kubeconfig,
      'PodVolumeBackup',
      VELERO_NAMESPACE,
      `velero.io/backup-name=${backupName}`,
    );
    // A terminal backup should leave every PVB Completed; anything else —
    // including a PVB stuck with no phase (the NODE_NAME-hang symptom) — means
    // volume data is missing.
    return items
      .filter((pvb) => (pvb?.status?.phase ?? '') !== 'Completed')
      .map(
        (pvb) =>
          `${pvb?.spec?.pod?.namespace ?? '?'}/${pvb?.spec?.volume ?? '?'}=${pvb?.status?.phase ?? 'no-status'}`,
      );
  }
}
