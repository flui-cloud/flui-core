import { BadRequestException, Injectable } from '@nestjs/common';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { RELEASE } from '../../../config/release.config';
import { HeldFile } from './manifest-master.service';
import {
  BootstrapFilesService,
  MasterKind,
  ReleaseFile,
} from './bootstrap-files.service';
import { ReleaseManifestService } from './release-manifest.service';
import { ImageTagSlot, InstallRecord } from '../utils/install-values.util';
import { bareRepository } from '../utils/declared-image.util';
import {
  PLATFORM_UPDATE_COMPONENTS,
  repositoryOf,
} from '../constants/platform-update-components';
import { candidateRefList } from '../utils/install-candidates.util';
import { TemplatesByRef, provableNames } from '../utils/install-proof.util';

/** The published releases a master may have been built from, and their templates. */
@Injectable()
export class InstallSourcesService {
  constructor(
    private readonly files: BootstrapFilesService,
    private readonly releases: ReleaseManifestService,
  ) {}

  templatesFor(
    ref: string,
    names: string[],
    kind: MasterKind,
  ): Promise<ReleaseFile[]> {
    return this.files.templatesFor(ref, names, kind);
  }

  async templatesByRef(
    refs: string[],
    onMaster: Map<string, HeldFile>,
    kind: MasterKind,
  ): Promise<TemplatesByRef> {
    const names = provableNames(onMaster);
    const perRef: TemplatesByRef = [];
    for (const ref of refs) {
      perRef.push([ref, await this.files.templatesFor(ref, names, kind)]);
    }
    return perRef;
  }

  /** Every tag a published release shipped for the component behind a slot. */
  async publishedImages(slots: ImageTagSlot[]): Promise<string[]> {
    const releases = await this.releases
      .getManifest()
      .then((m) => m.manifest.releases)
      .catch(() => []);
    const out = new Set<string>();
    for (const slot of slots) {
      const def = PLATFORM_UPDATE_COMPONENTS.find((d) => {
        const repository = repositoryOf(d);
        return (
          repository !== null &&
          bareRepository(repository) === bareRepository(slot.repository)
        );
      });
      if (!def) continue;
      for (const r of releases) {
        const tag = r.images?.[def.key];
        if (tag) out.add(`${slot.repository}:${tag}`);
      }
    }
    return [...out];
  }

  async firstSecretIndex(
    refs: string[],
  ): Promise<Map<string, string[]> | null> {
    for (const ref of [RELEASE.bootstrapRef, ...refs]) {
      const index = await this.files.secrets(ref);
      if (index) return index;
    }
    return null;
  }

  async secretIndex(refs: string[]): Promise<Map<string, string[]>> {
    const index = await this.firstSecretIndex(refs);
    if (index) return index;
    throw new BadRequestException(
      'No release this installation may come from lists its secret variables, so nothing can be reconstructed safely.',
    );
  }

  async candidateRefs(
    cluster: ClusterEntity,
    record: InstallRecord | null,
  ): Promise<string[]> {
    const published = await this.releases
      .getManifest()
      .then((m) => m.manifest.releases.map((r) => r.bootstrapRef))
      .catch(() => [] as string[]);
    return candidateRefList(record, cluster, published);
  }
}
