import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { TemplateRendererService } from './template-renderer.service';
import { StorageBackendFactory } from '../../storage/factories/storage-backend.factory';
import {
  VELERO_NAMESPACE,
  VELERO_DEPLOYMENT_NAME,
  VELERO_NODE_AGENT_DAEMONSET,
  VELERO_IMAGE,
  VELERO_AWS_PLUGIN_IMAGE,
  VELERO_CREDENTIALS_SECRET_NAME,
} from '../backups.constants';

export interface VeleroInstallContext {
  kubeconfig: string;
  destinations: BackupDestinationEntity[];
  primaryDestinationId: string;
}

@Injectable()
export class VeleroInstallerService {
  private readonly logger = new Logger(VeleroInstallerService.name);

  constructor(
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
    private readonly destRepo: BackupDestinationRepository,
    private readonly templates: TemplateRendererService,
    private readonly storageFactory: StorageBackendFactory,
  ) {}

  bslName(destinationId: string): string {
    return `flui-dest-${destinationId.slice(0, 8)}`;
  }

  async ensureInstalled(ctx: VeleroInstallContext): Promise<void> {
    const { kubeconfig, destinations, primaryDestinationId } = ctx;
    if (destinations.length === 0) {
      throw new Error('At least one destination required to install Velero');
    }

    await this.k8s.applyManifest(
      kubeconfig,
      this.templates.render('velero/velero-namespace.yaml.tpl', {
        NAMESPACE: VELERO_NAMESPACE,
      }),
    );
    await this.k8s.applyManifest(
      kubeconfig,
      this.templates.render('velero/velero-crds.yaml', {}),
    );
    await this.k8s.applyManifest(
      kubeconfig,
      this.templates.render('velero/velero-rbac.yaml.tpl', {
        NAMESPACE: VELERO_NAMESPACE,
      }),
    );

    // Use the primary destination for the credentials secret used by Velero deployment.
    const primary = destinations.find((d) => d.id === primaryDestinationId);
    if (!primary) {
      throw new Error('Primary destination not found in install context');
    }

    const accessKey = this.encryption.decrypt(primary.accessKeyEncrypted);
    const secretKey = this.encryption.decrypt(primary.secretKeyEncrypted);
    const passphrase = primary.encryptionPassphraseEncrypted
      ? this.encryption.decrypt(primary.encryptionPassphraseEncrypted)
      : crypto.randomBytes(32).toString('hex');

    await this.k8s.applyManifest(
      kubeconfig,
      this.templates.render('velero/velero-credentials-secret.yaml.tpl', {
        NAMESPACE: VELERO_NAMESPACE,
        SECRET_NAME: VELERO_CREDENTIALS_SECRET_NAME,
        ACCESS_KEY: accessKey,
        SECRET_KEY: secretKey,
        KOPIA_PASSPHRASE: passphrase,
      }),
    );

    await this.k8s.applyManifest(
      kubeconfig,
      this.templates.render('velero/velero-deployment.yaml.tpl', {
        NAMESPACE: VELERO_NAMESPACE,
        SECRET_NAME: VELERO_CREDENTIALS_SECRET_NAME,
        VELERO_IMAGE,
        AWS_PLUGIN_IMAGE: VELERO_AWS_PLUGIN_IMAGE,
      }),
    );

    await this.applyNodeAgent(kubeconfig);

    // Create one BSL per destination
    for (const dest of destinations) {
      await this.applyBSL(kubeconfig, dest, dest.id === primaryDestinationId);
    }

    // Wait for velero deployment readiness
    await this.k8s.waitForReady(
      kubeconfig,
      'Deployment',
      VELERO_DEPLOYMENT_NAME,
      VELERO_NAMESPACE,
      10 * 60 * 1000,
    );
    // The node-agent DaemonSet does the Kopia fs-backup; a backup started
    // before it is Ready silently produces PartiallyFailed backups with
    // missing volume data. (waitForReady has no DaemonSet readiness case, so
    // check numberReady explicitly here.)
    await this.waitForNodeAgentReady(kubeconfig);
  }

  // Idempotent re-apply of the node-agent DaemonSet. Called on the
  // already-installed path so an install predating the NODE_NAME fix self-heals
  // on the next backup (kubectl apply is a no-op once the spec matches).
  async applyNodeAgent(kubeconfig: string): Promise<void> {
    await this.k8s.applyManifest(
      kubeconfig,
      this.templates.render('velero/velero-node-agent.yaml.tpl', {
        NAMESPACE: VELERO_NAMESPACE,
        SECRET_NAME: VELERO_CREDENTIALS_SECRET_NAME,
        VELERO_IMAGE,
      }),
    );
  }

  async waitForNodeAgentReady(
    kubeconfig: string,
    timeoutMs: number = 10 * 60 * 1000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ds = await this.k8s.getResource(
        kubeconfig,
        'DaemonSet',
        VELERO_NODE_AGENT_DAEMONSET,
        VELERO_NAMESPACE,
      );
      const status = ds?.body?.status ?? ds?.status;
      const generation =
        ds?.body?.metadata?.generation ?? ds?.metadata?.generation ?? 0;
      const desired = status?.desiredNumberScheduled ?? 0;
      const ready = status?.numberReady ?? 0;
      const updated = status?.updatedNumberScheduled ?? 0;
      const observedGen = status?.observedGeneration ?? 0;
      // Rollout-aware: require the controller to have observed the latest spec
      // and all pods updated + ready, so a re-applied (NODE_NAME) node-agent
      // isn't reported ready on stale old pods still rolling out.
      if (
        desired > 0 &&
        observedGen >= generation &&
        updated >= desired &&
        ready >= desired
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error(
      `Velero node-agent DaemonSet did not become ready within ${timeoutMs}ms`,
    );
  }

  async applyBSL(
    kubeconfig: string,
    dest: BackupDestinationEntity,
    isDefault: boolean,
  ): Promise<void> {
    const backend = this.storageFactory.forProvider(dest.provider);
    const accessKey = this.encryption.decrypt(dest.accessKeyEncrypted);
    const secretKey = this.encryption.decrypt(dest.secretKeyEncrypted);
    const bsl = backend.toVeleroBSL({
      provider: dest.provider,
      endpoint: dest.endpoint,
      region: dest.region,
      bucket: dest.bucket,
      accessKey,
      secretKey,
      forcePathStyle: dest.forcePathStyle,
      pathPrefix: dest.pathPrefix,
    });

    await this.k8s.applyManifest(
      kubeconfig,
      this.templates.render('velero/velero-bsl.yaml.tpl', {
        BSL_NAME: this.bslName(dest.id),
        NAMESPACE: VELERO_NAMESPACE,
        DESTINATION_ID: dest.id,
        IS_DEFAULT: String(isDefault),
        BUCKET: bsl.bucket,
        PREFIX: bsl.prefix ?? '',
        REGION: dest.region,
        FORCE_PATH_STYLE: bsl.config.s3ForcePathStyle,
        ENDPOINT: dest.endpoint,
        SECRET_NAME: VELERO_CREDENTIALS_SECRET_NAME,
      }),
    );
  }

  async isInstalled(kubeconfig: string): Promise<boolean> {
    const dep = await this.k8s.getResource(
      kubeconfig,
      'Deployment',
      VELERO_DEPLOYMENT_NAME,
      VELERO_NAMESPACE,
    );
    return !!dep;
  }

  daemonsetName(): string {
    return VELERO_NODE_AGENT_DAEMONSET;
  }
}
