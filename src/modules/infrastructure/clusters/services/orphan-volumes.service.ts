import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { ProviderFactory } from 'src/modules/providers/services/provider.factory';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import {
  ICloudProvider,
  ProviderVolumeSummary,
} from 'src/modules/providers/interfaces/cloud-provider.interface';
import {
  KnownVolumeRefs,
  normalizeVolumeRef,
  sameVolumeRef,
} from '../utils/provider-volume-ref';

export interface OrphanVolume {
  provider: string;
  volumeId: string;
  name: string;
  sizeGb: number;
  region?: string;
  attached: boolean;
  attachedServerId: string | null;
  labels: Record<string, string>;
  createdAt?: string;
  reason: 'no-matching-cluster' | 'cluster-volume-id-mismatch';
}

/**
 * The block volumes at a provider that no cluster in this registry points at.
 *
 * Deleting one destroys a paid-for disk and everything on it, so the listing
 * and the deletion answer to two different standards. The listing may be
 * generous — naming a volume costs nothing. The deletion is the opposite: it
 * proceeds only when every question it can ask has been answered, and refuses
 * out loud whenever one of them cannot be.
 */
@Injectable()
export class OrphanVolumesService {
  private readonly logger = new Logger(OrphanVolumesService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly providerFactory: ProviderFactory,
  ) {}

  async scan(providers?: CloudProvider[]): Promise<OrphanVolume[]> {
    const targets = providers?.length
      ? providers
      : [CloudProvider.HETZNER, CloudProvider.SCALEWAY];
    const clusterVolumeIds = await this.knownClusterVolumeIds();

    const out: OrphanVolume[] = [];
    for (const p of targets) {
      const provider = this.providerFactory.getProvider(p);
      if (!provider.listFluiManagedVolumes) continue;
      let volumes: ProviderVolumeSummary[];
      try {
        volumes = await provider.listFluiManagedVolumes();
      } catch (err) {
        this.logger.warn(
          `${p} listFluiManagedVolumes failed: ${(err as Error).message}`,
        );
        continue;
      }
      for (const v of volumes) {
        if (clusterVolumeIds.has(v.volumeId)) continue;
        out.push({
          provider: p,
          volumeId: v.volumeId,
          name: v.name,
          sizeGb: v.sizeGb,
          region: v.region,
          attached: !!v.attachedServerId,
          attachedServerId: v.attachedServerId ?? null,
          labels: v.labels,
          createdAt: v.createdAt,
          reason: 'no-matching-cluster',
        });
      }
    }
    return out;
  }

  /**
   * Detach and delete one volume the scan called orphaned.
   *
   * Four fences, in this order, and every one of them refuses rather than
   * guesses:
   *  1. an id this code cannot read is not deleted;
   *  2. a volume the registry still points at is not deleted — asked through
   *     {@link KnownVolumeRefs}, so `fr-par-1:abc` and `abc` are one volume;
   *  3. a volume the provider does not report back to us, reports twice, or
   *     cannot be listed at all, is not deleted — an unverifiable state is a
   *     refusal, never a default of "go ahead";
   *  4. a volume still attached to a server is not deleted. This call removes
   *     no server, so every attachment is to a machine that stays, and a disk
   *     under a running machine is somebody's live data.
   */
  async cleanup(
    provider: CloudProvider,
    volumeId: string,
  ): Promise<{ deleted: boolean; message: string }> {
    if (!normalizeVolumeRef(volumeId)) {
      throw new ConflictException(
        `"${volumeId}" cannot be read as a provider volume id — refusing to delete`,
      );
    }
    const knownIds = await this.knownClusterVolumeIds();
    if (knownIds.has(volumeId)) {
      throw new ConflictException(
        `Volume ${volumeId} is still referenced by an existing cluster — refusing to delete`,
      );
    }
    const svc = this.providerFactory.getProvider(provider);
    if (!svc.deleteVolume) {
      return {
        deleted: false,
        message: `Provider ${provider} has no deleteVolume primitive`,
      };
    }

    const seen = await this.seenAtProvider(provider, svc, volumeId);
    if (seen.attachedServerId) {
      throw new ConflictException(
        `Volume ${volumeId} is still attached to server ${seen.attachedServerId}, ` +
          `which this call does not remove — refusing to delete`,
      );
    }

    if (svc.detachVolume) {
      try {
        await svc.detachVolume(volumeId);
      } catch (err) {
        this.logger.warn(
          `Detach failed for ${volumeId}: ${(err as Error).message}`,
        );
      }
    }
    await svc.deleteVolume(volumeId);
    return { deleted: true, message: `Deleted ${volumeId} from ${provider}` };
  }

  /**
   * What the provider itself says about this volume right now.
   *
   * The registry only knows what Flui wrote down; the attachment is a fact that
   * lives at the provider and nowhere else, so it has to be read there at the
   * moment of the delete. Failing to read it is a refusal: the provider's own
   * words are the only evidence that the disk is free.
   */
  private async seenAtProvider(
    provider: CloudProvider,
    svc: ICloudProvider,
    volumeId: string,
  ): Promise<ProviderVolumeSummary> {
    if (!svc.listFluiManagedVolumes) {
      throw new ConflictException(
        `Provider ${provider} cannot list its Flui-managed volumes, so the state ` +
          `of ${volumeId} cannot be verified — refusing to delete`,
      );
    }
    let volumes: ProviderVolumeSummary[];
    try {
      volumes = await svc.listFluiManagedVolumes();
    } catch (err) {
      // The provider's message can carry account detail, so it goes to the log
      // and not to the caller.
      this.logger.warn(
        `${provider} listFluiManagedVolumes failed during cleanup of ${volumeId}: ${
          (err as Error).message
        }`,
      );
      throw new ConflictException(
        `Could not read the Flui-managed volumes of ${provider}, so the state of ` +
          `${volumeId} cannot be verified — refusing to delete`,
      );
    }
    const matches = volumes.filter((v) => sameVolumeRef(v.volumeId, volumeId));
    if (matches.length === 0) {
      throw new NotFoundException(
        `${provider} does not report ${volumeId} among its Flui-managed volumes — refusing to delete`,
      );
    }
    if (matches.length > 1) {
      throw new ConflictException(
        `More than one Flui-managed volume at ${provider} answers to ${volumeId} — refusing to delete`,
      );
    }
    return matches[0];
  }

  private async knownClusterVolumeIds(): Promise<KnownVolumeRefs> {
    const clusters = await this.clusterRepository.find();
    const ids = new KnownVolumeRefs();
    for (const c of clusters) ids.add(c.sharedStorageVolumeId);
    return ids;
  }
}
