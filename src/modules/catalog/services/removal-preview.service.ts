import { Injectable, Logger } from '@nestjs/common';
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
} from '../dto/removal-preview.dto';

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
  ) {}

  async preview(applicationId: string): Promise<RemovalPreviewDto> {
    const app = await this.applications.findById(applicationId);
    const install = await this.installer.findInstallByApplicationId(
      applicationId,
      app.clusterId,
    );

    const members = install
      ? await this.resolveMembers(install.applicationIds ?? [], app)
      : [app];
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
