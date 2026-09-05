import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { RELEASE } from '../../../config/release.config';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationCategory } from '../../applications/enums/application-category.enum';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import {
  ClusterEntity,
  ClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { findSystemAppByLabel as findSystemApp } from '../../applications/constants/system-app-catalog';
import {
  PLATFORM_UPDATE_COMPONENTS,
  PlatformComponentKey,
  PlatformUpdateComponentDef,
  repositoryOf,
} from '../constants/platform-update-components';
import { findSystemAppByLabel } from '../../applications/constants/system-app-catalog';
import { PlatformReleaseEntry } from '../interfaces/release-manifest.interface';
import {
  PlatformComponentUpdateDto,
  PlatformUpdateAdvisoryDto,
  PlatformUpdateStatusDto,
} from '../dto/platform-update.dto';
import { ReleaseManifestService } from './release-manifest.service';
import {
  compareVersions,
  isNewerThan,
  isReleaseVersion,
} from '../utils/version-compare';

/**
 * Answers "is this installation behind, and what would catching up move".
 *
 * Read-only: it compares what runs against what is published and says what an
 * update would entail. Applying one is a separate, queued operation.
 */
interface ComponentReading {
  /** Whether the component exists on this installation at all. */
  installed: boolean;
  /** Image tag, when there is one to read. Null for a digest-pinned image. */
  version: string | null;
  /** False when the version comes from a pin because the cluster was unreachable. */
  observed: boolean;
}

@Injectable()
export class PlatformUpdatesService {
  private readonly logger = new Logger(PlatformUpdatesService.name);

  constructor(
    private readonly releaseManifest: ReleaseManifestService,
    private readonly applicationsRepository: ApplicationsRepository,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async getStatus(force = false): Promise<PlatformUpdateStatusDto> {
    const installedVersion = RELEASE.version;
    const installedTags = await this.installedTags();

    let release: PlatformReleaseEntry | null = null;
    let checkedAt = new Date();
    let checkError: string | null = null;
    try {
      const { manifest, fetchedAt } =
        await this.releaseManifest.getManifest(force);
      checkedAt = fetchedAt;
      release =
        manifest.releases.find((r) =>
          isNewerThan(r.version, installedVersion),
        ) ?? null;
    } catch (err) {
      checkError = (err as Error).message;
      this.logger.warn(`Update check failed: ${checkError}`);
    }

    const components = PLATFORM_UPDATE_COMPONENTS.map((def) =>
      this.describeComponent(def, installedTags, release),
    );
    const advisories = this.advisories(release, components, checkError);

    return {
      installedVersion,
      availableVersion: release?.version ?? null,
      updateAvailable: release !== null,
      applicable:
        release !== null && !advisories.some((a) => a.level === 'blocker'),
      publishedAt: release?.publishedAt ?? null,
      notes: release?.notes ?? [],
      migrations: release?.migrations ?? 0,
      components,
      advisories,
      checkedAt: checkedAt.toISOString(),
      checkError,
    };
  }

  /**
   * The exact image each component would be moved to.
   *
   * Derived from the ref the cluster is running by swapping its tag, so a
   * mirrored or otherwise non-default registry keeps being used; the catalog
   * composes one only when nothing is running to copy from.
   */
  async imageRefsFor(
    components: PlatformComponentUpdateDto[],
  ): Promise<Record<string, string>> {
    const apps = await this.componentApps();
    const out: Record<string, string> = {};
    for (const def of PLATFORM_UPDATE_COMPONENTS) {
      const target = components.find((c) => c.key === def.key)?.targetVersion;
      if (!target) continue;
      const running = apps.get(def.key)?.imageRef ?? null;
      const base = running
        ? running.split('@')[0].replace(/:[^:/]+$/, '')
        : this.catalogImageBase(def);
      if (base) out[def.key] = `${base}:${target}`;
    }
    return out;
  }

  private catalogImageBase(def: PlatformUpdateComponentDef): string | null {
    const repository = repositoryOf(def);
    if (!repository) return null;
    const app = findSystemAppByLabel(def.systemAppLabel);
    const host =
      app?.imageSource?.registry === 'ghcr' ? 'ghcr.io' : 'docker.io';
    return `${host}/${repository}`;
  }

  /** The system-app row backing each platform component, keyed by component. */
  private async componentApps(): Promise<
    Map<PlatformComponentKey, ApplicationEntity>
  > {
    const systemApps = await this.controlClusterSystemApps();
    const out = new Map<PlatformComponentKey, ApplicationEntity>();
    for (const def of PLATFORM_UPDATE_COMPONENTS) {
      const app = systemApps.find(
        (a) => (a.labels?.['app'] ?? a.slug) === def.systemAppLabel,
      );
      if (app) out.set(def.key, app);
    }
    return out;
  }

  /** The application id to deploy through, per component. */
  async componentAppIds(): Promise<Map<PlatformComponentKey, string>> {
    const apps = await this.componentApps();
    return new Map([...apps].map(([key, app]) => [key, app.id]));
  }

  /**
   * What each component is actually running.
   *
   * The cluster is the authority for all three, the API included: this answer
   * describes the installation, and the build serving the request is not always
   * the build the installation runs — a local API pointed at a remote cluster is
   * the everyday case, and reporting its own version there would describe the
   * developer's laptop. The env pin and the compiled pin are fallbacks, in that
   * order, for an installation whose system apps were never discovered.
   */
  private async installedTags(): Promise<
    Record<PlatformComponentKey, ComponentReading>
  > {
    const apps = await this.componentApps();
    const readings = {} as Record<PlatformComponentKey, ComponentReading>;
    for (const def of PLATFORM_UPDATE_COMPONENTS) {
      // A row whose imageRef is empty or digest-pinned carries no version to
      // report, so it falls through to the cluster rather than answering null:
      // the row proves the component was discovered once, not what it runs now.
      const tag = this.tagOf(apps.get(def.key)?.imageRef);
      readings[def.key] = tag
        ? { installed: true, version: tag, observed: true }
        : await this.readFromCluster(def);
    }
    return readings;
  }

  /**
   * No system-app row — which is not the same as "not installed": discovery may
   * simply never have run. So the cluster is asked directly, and only a
   * Deployment that genuinely is not there reads as absent.
   *
   * The pinned tag is used only when the cluster cannot be reached at all, and
   * is marked as unobserved so nothing downstream presents a pin as a fact. It
   * is what `flui-authz` on an installation that never installed it needs:
   * before this, the pin invented a version for a component with no workload
   * and no row, and the page reported it as up to date.
   */
  private async readFromCluster(
    def: PlatformUpdateComponentDef,
  ): Promise<ComponentReading> {
    const pin =
      def.key === 'fluiApi'
        ? (process.env.FLUI_API_IMAGE_TAG ?? RELEASE.images.fluiApi)
        : def.key === 'fluiWeb'
          ? (process.env.FLUI_WEB_IMAGE_TAG ?? RELEASE.images.fluiWeb)
          : (process.env.FLUI_AUTHZ_IMAGE_TAG ?? RELEASE.images.fluiAuthz);
    const catalogEntry = findSystemApp(def.systemAppLabel);
    const cluster = await this.controlCluster();
    if (!cluster?.kubeconfigEncrypted || !catalogEntry?.imageSource) {
      return { installed: true, version: pin, observed: false };
    }
    try {
      const image = await this.kubernetesService.getDeploymentContainerImage(
        this.encryptionService.decrypt(cluster.kubeconfigEncrypted),
        catalogEntry.k8sNamespace,
        catalogEntry.imageSource.deploymentName ?? def.systemAppLabel,
        catalogEntry.imageSource.containerName,
      );
      if (!image) {
        return { installed: false, version: null, observed: true };
      }
      return { installed: true, version: this.tagOf(image), observed: true };
    } catch (err) {
      this.logger.debug(
        `Could not read ${def.systemAppLabel} from the control cluster: ${(err as Error).message}`,
      );
      return { installed: true, version: pin, observed: false };
    }
  }

  private async controlCluster(): Promise<ClusterEntity | null> {
    // Legacy rows still say `observability` for the control cluster — the same
    // pair every other "which cluster is the control cluster" lookup reads.
    return this.clusterRepository.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
    });
  }

  private async controlClusterSystemApps(): Promise<ApplicationEntity[]> {
    const control = await this.controlCluster();
    if (!control) return [];
    return this.applicationsRepository.findByClusterIdAndCategory(
      control.id,
      ApplicationCategory.SYSTEM,
    );
  }

  /** `ghcr.io/flui-cloud/core:0.14.0` → `0.14.0`; digest-pinned refs have none. */
  private tagOf(imageRef?: string | null): string | null {
    if (!imageRef) return null;
    const withoutDigest = imageRef.split('@')[0];
    const lastColon = withoutDigest.lastIndexOf(':');
    const lastSlash = withoutDigest.lastIndexOf('/');
    if (lastColon <= lastSlash) return null;
    return withoutDigest.slice(lastColon + 1);
  }

  private describeComponent(
    def: PlatformUpdateComponentDef,
    installed: Record<PlatformComponentKey, ComponentReading>,
    release: PlatformReleaseEntry | null,
  ): PlatformComponentUpdateDto {
    const reading = installed[def.key];
    const installedVersion = reading.installed ? reading.version : null;
    const targetVersion = release?.images?.[def.key] ?? null;
    // An uncomparable pair — a commit build against a release tag — is a
    // change, not a match: `compareVersions` answers null there, and treating
    // null as "same" would leave a sha-pinned component behind for good.
    const changed =
      reading.installed &&
      targetVersion !== null &&
      installedVersion !== null &&
      compareVersions(targetVersion, installedVersion) !== 0;
    return {
      key: def.key,
      name: def.name,
      role: def.role,
      deploymentName: def.systemAppLabel,
      installed: reading.installed,
      observed: reading.observed,
      installedVersion,
      targetVersion,
      installedIsRelease: isReleaseVersion(installedVersion),
      changed,
      restartsControlPlane: def.restartsControlPlane,
    };
  }

  private advisories(
    release: PlatformReleaseEntry | null,
    components: PlatformComponentUpdateDto[],
    checkError: string | null,
  ): PlatformUpdateAdvisoryDto[] {
    const out: PlatformUpdateAdvisoryDto[] = [];

    if (checkError) {
      out.push({
        level: 'blocker',
        title: 'Could not check for updates',
        detail: `The release manifest is unreachable: ${checkError}`,
      });
    }

    // Said whether or not a release is on offer: a component pinned to a commit
    // build is not on the release train at all, and the rest of this page would
    // otherwise read as if it were.
    const offTrain = components.filter(
      (c) => c.installed && c.installedVersion && !c.installedIsRelease,
    );
    for (const component of offTrain) {
      out.push({
        level: 'warning',
        title: `${component.deploymentName} is running a build, not a release`,
        detail: `Its image is pinned to ${component.installedVersion}, which is not a release version. Applying a release moves it onto the release image.`,
      });
    }

    if (!release) return out;

    if (release.requiresBootstrap) {
      out.push({
        level: 'blocker',
        title: 'This release changes the bootstrap manifests',
        detail:
          'An in-app update moves image tags only. Install this release with the CLI (flui env) instead.',
      });
    }
    if (
      release.minFrom &&
      compareVersions(RELEASE.version, release.minFrom) === -1
    ) {
      out.push({
        level: 'blocker',
        title: `Update to ${release.minFrom} first`,
        detail: `Release ${release.version} cannot be applied directly from ${RELEASE.version}.`,
      });
    }
    if (release.migrations > 0) {
      out.push({
        level: 'warning',
        title: `${release.migrations} database migration${release.migrations === 1 ? '' : 's'} will run`,
        detail:
          'Applied by the new API at start-up — a rollback restores the images, not the schema.',
      });
    }
    if (components.some((c) => c.changed && c.restartsControlPlane)) {
      out.push({
        level: 'warning',
        title: 'The API restarts once',
        detail:
          'The dashboard and the CLI wait about a minute while it comes back. Running applications keep serving traffic.',
      });
    }
    return out;
  }
}
