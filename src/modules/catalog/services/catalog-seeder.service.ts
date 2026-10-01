import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectPath } from '../../../common/utils/project-root.util';
import { CatalogAppDefinitionRepository } from '../repositories/catalog-app-definition.repository';
import { CatalogManifestLoaderService } from './catalog-manifest-loader.service';
import { CatalogAppType } from '../enums/catalog-app-type.enum';
import { CatalogManifest } from '../interfaces/catalog-manifest.interface';
import { CatalogAppDefinitionEntity } from '../entities/catalog-app-definition.entity';
import { mapCatalogCategoryToKind } from '../utils/category-to-kind';

function stringArrayEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x.localeCompare(y));
  const sb = [...b].sort((x, y) => x.localeCompare(y));
  return sa.every((v, i) => v === sb[i]);
}

export function buildUpsertPayload(
  manifest: CatalogManifest,
  rawYaml: string,
  checksum: string,
  isPublished = true,
): Parameters<CatalogAppDefinitionRepository['upsert']>[0] {
  return {
    slug: manifest.metadata.id,
    version: manifest.metadata.version,
    name: manifest.metadata.name,
    description: manifest.metadata.description,
    category: manifest.metadata.category,
    appKind:
      manifest.metadata.appKind ??
      mapCatalogCategoryToKind(manifest.metadata.category),
    appType: manifest.spec.type as CatalogAppType,
    tags: manifest.metadata.tags ?? [],
    license: manifest.metadata.license,
    iconUrl: manifest.metadata.icon,
    links: manifest.metadata.links,
    ratings: manifest.metadata.ratings,
    alternativeTo: manifest.metadata.alternativeTo ?? [],
    maintainedAt: manifest.metadata.maintainedAt,
    entrypointPath: manifest.metadata.entrypointPath,
    clientFor: manifest.metadata.clientFor ?? [],
    clientDefaultFor: manifest.metadata.clientDefaultFor ?? [],
    rawYaml,
    manifest: manifest,
    checksum,
    isPublished,
    isActive: true,
    ownerUserId: null,
  };
}

@Injectable()
export class CatalogSeederService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogSeederService.name);

  constructor(
    private readonly repo: CatalogAppDefinitionRepository,
    private readonly loader: CatalogManifestLoaderService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const seedDir = getProjectPath('src', 'modules', 'catalog', 'seed');
    let files: string[];
    try {
      files = readdirSync(seedDir).filter((f) => f.endsWith('.flui.yaml'));
    } catch (err) {
      this.logger.warn(
        `Catalog seed directory not readable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    for (const file of files) {
      try {
        await this.seedFile(join(seedDir, file));
      } catch (err) {
        this.logger.error(
          `Failed to seed ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async seedFile(path: string): Promise<void> {
    const rawYaml = readFileSync(path, 'utf-8');
    const { manifest, checksum } = this.loader.load(rawYaml);

    const existing = await this.repo.findBySlugAndVersion(
      manifest.metadata.id,
      manifest.metadata.version,
    );
    const isPublished = !manifest.metadata.draft;

    if (existing?.checksum === checksum) {
      // Same manifest content, but the seeder policy may have changed (e.g.
      // isPublished default, clientFor denormalization). Reconcile derived
      // flags without a full upsert so existing rows pick up new behavior.
      const drift: Partial<CatalogAppDefinitionEntity> = {};
      if (existing.isPublished !== isPublished) drift.isPublished = isPublished;
      const nextClientFor = manifest.metadata.clientFor ?? [];
      const nextClientDefaultFor = manifest.metadata.clientDefaultFor ?? [];
      if (!stringArrayEquals(existing.clientFor ?? [], nextClientFor)) {
        drift.clientFor = nextClientFor;
      }
      if (
        !stringArrayEquals(
          existing.clientDefaultFor ?? [],
          nextClientDefaultFor,
        )
      ) {
        drift.clientDefaultFor = nextClientDefaultFor;
      }
      if (Object.keys(drift).length > 0) {
        await this.repo.updateById(existing.id, drift);
        this.logger.log(
          `Reconciled ${manifest.metadata.id}@${manifest.metadata.version}: ${Object.keys(drift).join(', ')}`,
        );
      }
      return;
    }

    await this.repo.upsert(
      buildUpsertPayload(manifest, rawYaml, checksum, isPublished),
    );

    // Purge older versions of the same slug so the catalog only surfaces the
    // currently-maintained one. Rows still referenced by live installs are
    // kept in DB (isActive=false) to preserve FK integrity.
    const { deactivated, deleted } = await this.repo.cleanupPreviousVersions(
      manifest.metadata.id,
      manifest.metadata.version,
    );

    const cleanupSuffix: string[] = [];
    if (deleted > 0) {
      cleanupSuffix.push(`deleted ${deleted}`);
    }
    const retired = deactivated - deleted;
    if (retired > 0) {
      cleanupSuffix.push(`retired ${retired} (still referenced by installs)`);
    }

    this.logger.log(
      `Seeded catalog app ${manifest.metadata.id}@${manifest.metadata.version}` +
        (cleanupSuffix.length ? ` — cleanup: ${cleanupSuffix.join(', ')}` : ''),
    );
  }
}
