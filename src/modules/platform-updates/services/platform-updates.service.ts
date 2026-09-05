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
import { compareVersions, isNewerThan } from '../utils/version-compare';

/**
 * Answers "is this installation behind, and what would catching up move".
 *
 * Read-only: it compares what runs against what is published and says what an
 * update would entail. Applying one is a separate, queued operation.
 */
@Injectable()
export class PlatformUpdatesService {
  private readonly logger = new Logger(PlatformUpdatesService.name);

  constructor(
    private readonly releaseManifest: ReleaseManifestService,
    private readonly applicationsRepository: ApplicationsRepository,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
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
   * The API answers for itself from its own build — that is the one version no
   * cluster read can contradict. The other two come from the system-app rows,
   * whose `imageRef` is written by discovery and by every deploy that goes
   * through `setDesiredImage`; the compiled pins are the fallback for an
   * installation whose system apps were never discovered.
   */
  private async installedTags(): Promise<
    Record<PlatformComponentKey, string | null>
  > {
    const tags: Record<PlatformComponentKey, string | null> = {
      fluiApi: process.env.FLUI_API_IMAGE_TAG ?? RELEASE.images.fluiApi,
      fluiWeb: null,
      fluiAuthz: null,
    };

    const apps = await this.componentApps();
    for (const def of PLATFORM_UPDATE_COMPONENTS) {
      if (def.key === 'fluiApi') continue;
      const app = apps.get(def.key);
      tags[def.key] =
        this.tagOf(app?.imageRef) ?? RELEASE.images[def.key] ?? null;
    }
    return tags;
  }

  private async controlClusterSystemApps(): Promise<ApplicationEntity[]> {
    // Legacy rows still say `observability` for the control cluster — the same
    // pair every other "which cluster is the control cluster" lookup reads.
    const control = await this.clusterRepository.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
    });
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
    installed: Record<PlatformComponentKey, string | null>,
    release: PlatformReleaseEntry | null,
  ): PlatformComponentUpdateDto {
    const installedVersion = installed[def.key];
    const targetVersion = release?.images?.[def.key] ?? null;
    return {
      key: def.key,
      name: def.name,
      role: def.role,
      installedVersion,
      targetVersion,
      changed:
        targetVersion !== null &&
        installedVersion !== null &&
        compareVersions(targetVersion, installedVersion) !== 0,
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
