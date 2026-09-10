import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationService } from '../../applications/services/application.service';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { AppResourcesRepository } from '../../applications/repositories/app-resources.repository';
import {
  ApplicationVolumeClaim,
  ApplicationVolumeClaimsService,
} from '../../applications/services/application-volume-claims.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { CatalogInstallerService } from './catalog-installer.service';
import { formatStorageBytes } from '../../../common/utils/storage-quantity.util';
import {
  RemovalPreviewDto,
  RemovalPreviewVolumeDto,
  RemovalSnapshotOfferDto,
} from '../dto/removal-preview.dto';
import {
  ATTACHED_SERVICES_PORT,
  AttachedServicesPort,
} from '../../applications/interfaces/attached-services.port';
import { DB_ENGINE_LABEL } from '../../database-console/engine/engine-profile';

/**
 * What `DELETE /applications/:id/install` is about to take away.
 *
 * Uninstalling is the most destructive verb in the product and it never said
 * how much it destroyed. This is the half that says it, and it
 * lives in the API on purpose: the dashboard, the CLI and the MCP tool all read
 * the same sentence, which is the only way three surfaces ever agree.
 *
 * It mirrors the removal's own routing — a component of a catalog install
 * previews the WHOLE install, because that is what the delete will remove — and
 * it asks `ApplicationVolumeClaimsService` the same question the teardown sweep
 * asks, so what a person is warned about is what actually goes.
 */
@Injectable()
export class RemovalPreviewService {
  private readonly logger = new Logger(RemovalPreviewService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly encryption: EncryptionService,
    private readonly applications: ApplicationService,
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly appResources: AppResourcesRepository,
    private readonly volumeClaims: ApplicationVolumeClaimsService,
    private readonly installer: CatalogInstallerService,
    // The token, not the module: the implementation imports this one.
    @Optional()
    @Inject(ATTACHED_SERVICES_PORT)
    private readonly attachedServices?: AttachedServicesPort,
  ) {}

  async preview(applicationId: string): Promise<RemovalPreviewDto> {
    const app = await this.applications.findById(applicationId);
    const install = await this.installer.findInstallByApplicationId(
      applicationId,
      app.clusterId,
    );

    // The blocks this application attached go with it, so they are members of
    // the removal — which is what makes `claimsOf` count their volumes. Without
    // them a preview of an application with a 10Gi Postgres says "0 volumes",
    // and the one sentence all three surfaces share would be a lie.
    const attached = await this.attachedMembers(applicationId);
    const members = install
      ? await this.resolveMembers(install.applicationIds ?? [], app)
      : [app, ...attached.apps];
    const removes = install ? 'catalog-install' : 'application';
    const label = install
      ? `Uninstall ${install.displayName}`
      : `Delete ${app.name}`;

    const base: RemovalPreviewDto = {
      removes,
      label,
      applications: members.map((m) => ({
        id: m.id,
        name: m.name,
        slug: m.slug,
      })),
      volumes: [],
      totalBytes: 0,
      totalLabel: formatStorageBytes(0),
      volumesKnown: false,
      dataWarning: null,
      snapshotOffer: attached.offer,
    };

    const cluster = await this.clusters.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      base.note =
        'The cluster is not reachable from here, so the storage this removal ' +
        'takes with it could not be listed. It is not known to be none.';
      return base;
    }

    let kubeconfig: string;
    try {
      kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    } catch (err) {
      this.logger.warn(
        `removal preview could not read the kubeconfig of cluster ${cluster.id}: ${(err as Error).message}`,
      );
      base.note =
        'The cluster credentials could not be read, so the storage this ' +
        'removal takes with it could not be listed.';
      return base;
    }

    const volumes: RemovalPreviewVolumeDto[] = [];
    for (const member of members) {
      const claims = await this.claimsOf(kubeconfig, member);
      for (const claim of claims) {
        volumes.push(this.toDto(claim, member));
      }
    }

    // The same claim can be reached through two members of one install when
    // they share a namespace; count the bytes once.
    const unique = new Map<string, RemovalPreviewVolumeDto>();
    for (const v of volumes) unique.set(`${v.namespace}/${v.name}`, v);
    const deduped = [...unique.values()];
    const totalBytes = deduped.reduce((sum, v) => sum + v.requestedBytes, 0);

    return {
      ...base,
      volumes: deduped,
      totalBytes,
      totalLabel: formatStorageBytes(totalBytes),
      volumesKnown: true,
      dataWarning: this.warn(deduped.length, totalBytes),
    };
  }

  /**
   * The blocks an application attached to itself, and the offer to keep their
   * data first.
   *
   * Only for a standalone application: an application that is part of a catalog
   * install already previews the whole install, and a building block does not
   * attach services of its own.
   */
  private async attachedMembers(applicationId: string): Promise<{
    apps: ApplicationEntity[];
    offer: RemovalSnapshotOfferDto[];
  }> {
    if (!this.attachedServices) return { apps: [], offer: [] };

    const attachments =
      await this.attachedServices.attachmentsOf(applicationId);
    const apps: ApplicationEntity[] = [];
    const offer: RemovalSnapshotOfferDto[] = [];

    for (const attachment of attachments) {
      if (!attachment.bbApplicationId) continue;
      const blockApp = await this.applicationsRepository.findById(
        attachment.bbApplicationId,
      );
      if (!blockApp || blockApp.deletedAt) continue;
      apps.push(blockApp);

      const engine =
        (blockApp.labels as Record<string, string> | undefined)?.[
          DB_ENGINE_LABEL
        ] ?? null;
      offer.push({
        serviceName: attachment.name,
        block: attachment.block,
        applicationId: blockApp.id,
        applicationName: blockApp.name,
        engine,
        snapshotEndpoint: engine
          ? `POST /applications/${blockApp.id}/snapshots`
          : null,
        sentence: engine
          ? `Snapshot "${attachment.name}" (${attachment.block}) before removing it — ` +
            `its data goes with it and cannot be recovered afterwards.`
          : `"${attachment.name}" (${attachment.block}) is removed with this application. ` +
            `Flui cannot snapshot it — copy anything you need out of it first.`,
      });
    }

    return { apps, offer };
  }

  /** The one sentence. Null only when there provably is no storage to lose. */
  private warn(count: number, totalBytes: number): string | null {
    if (count === 0) return null;
    const volumes = count === 1 ? '1 volume' : `${count} volumes`;
    return (
      `This also deletes ${formatStorageBytes(totalBytes)} of data in ` +
      `${volumes}. It cannot be undone.`
    );
  }

  private async claimsOf(
    kubeconfig: string,
    app: ApplicationEntity,
  ): Promise<ApplicationVolumeClaim[]> {
    const tracked = await this.appResources
      .findByApplicationId(app.id)
      .catch(() => []);
    return this.volumeClaims.resolveForApplication(kubeconfig, app, tracked);
  }

  private toDto(
    claim: ApplicationVolumeClaim,
    app: ApplicationEntity,
  ): RemovalPreviewVolumeDto {
    return {
      name: claim.name,
      namespace: claim.namespace,
      applicationId: app.id,
      applicationName: app.name,
      requested: claim.requested,
      requestedBytes: claim.requestedBytes,
      sizeLabel: formatStorageBytes(claim.requestedBytes),
      storageClass: claim.storageClass,
      phase: claim.phase,
      attributedBy: claim.attributedBy,
    };
  }

  /**
   * The install's components, minus the ones already gone. A removal preview
   * that names a deleted sibling would be describing work nobody is about to
   * do.
   */
  private async resolveMembers(
    ids: string[],
    fallback: ApplicationEntity,
  ): Promise<ApplicationEntity[]> {
    const found: ApplicationEntity[] = [];
    for (const id of ids) {
      const app = await this.applicationsRepository.findById(id);
      if (app) found.push(app);
    }
    return found.length ? found : [fallback];
  }
}
