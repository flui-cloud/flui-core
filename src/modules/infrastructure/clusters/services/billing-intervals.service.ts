import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { NodeBillableIntervalEntity } from '../entities/node-billable-interval.entity';
import {
  VolumeBillableIntervalEntity,
  VolumeBillableKind,
} from '../entities/volume-billable-interval.entity';
import { ClusterEntity } from '../entities/cluster.entity';
import { NodeType } from '../entities/cluster-node.entity';
import { CostRatesService } from './cost-rates.service';

interface OpenNodeIntervalInput {
  clusterId: string;
  nodeId: string;
  serverName: string;
  providerResourceId?: string;
  provider: string;
  region: string;
  location?: string;
  serverType: string;
  nodeType: NodeType;
  startedAt?: Date;
  metadata?: Record<string, any>;
}

interface OpenVolumeIntervalInput {
  clusterId: string;
  volumeProviderId: string;
  provider: string;
  region: string;
  kind: VolumeBillableKind;
  sizeGb: number;
  startedAt?: Date;
  metadata?: Record<string, any>;
}

@Injectable()
export class BillingIntervalsService {
  private readonly logger = new Logger(BillingIntervalsService.name);

  constructor(
    @InjectRepository(NodeBillableIntervalEntity)
    private readonly nodeIntervalRepo: Repository<NodeBillableIntervalEntity>,
    @InjectRepository(VolumeBillableIntervalEntity)
    private readonly volumeIntervalRepo: Repository<VolumeBillableIntervalEntity>,
    @Optional() private readonly rates?: CostRatesService,
  ) {}

  async openNodeInterval(input: OpenNodeIntervalInput): Promise<void> {
    try {
      await this.closeNodeIntervals(
        input.nodeId,
        input.startedAt ?? new Date(),
      );
      const entity = this.nodeIntervalRepo.create({
        clusterId: input.clusterId,
        nodeId: input.nodeId,
        serverName: input.serverName,
        providerResourceId: input.providerResourceId,
        provider: input.provider,
        region: input.region,
        location: input.location,
        serverType: input.serverType,
        nodeType: input.nodeType,
        startedAt: input.startedAt ?? new Date(),
        endedAt: null,
        metadata: {
          ...input.metadata,
          ...(await this.nodePrice(input)),
        },
      });
      await this.nodeIntervalRepo.save(entity);
    } catch (err) {
      this.logger.warn(
        `openNodeInterval failed for node ${input.nodeId}: ${(err as Error).message}`,
      );
    }
  }

  /** The price the node is bought at, kept with its lifetime so a later list-price change never rewrites what it cost. */
  private async nodePrice(
    input: OpenNodeIntervalInput,
  ): Promise<{ price?: unknown }> {
    if (!this.rates) return {};
    try {
      const price = await this.rates.stampNode(
        input.provider,
        input.serverType,
        input.region,
        input.location,
        'recorded',
      );
      return price ? { price } : {};
    } catch (err) {
      this.logger.warn(
        `No price recorded for node ${input.nodeId}: ${(err as Error).message}`,
      );
      return {};
    }
  }

  private async volumePrice(provider: string): Promise<{ price?: unknown }> {
    if (!this.rates) return {};
    try {
      const price = await this.rates.stampVolume(provider, 'recorded');
      return price ? { price } : {};
    } catch (err) {
      this.logger.warn(
        `No price recorded for a ${provider} volume: ${(err as Error).message}`,
      );
      return {};
    }
  }

  async closeNodeIntervals(
    nodeId: string,
    at: Date = new Date(),
  ): Promise<void> {
    try {
      await this.nodeIntervalRepo.update(
        { nodeId, endedAt: IsNull() },
        { endedAt: at },
      );
    } catch (err) {
      this.logger.warn(
        `closeNodeIntervals failed for node ${nodeId}: ${(err as Error).message}`,
      );
    }
  }

  async openVolumeInterval(input: OpenVolumeIntervalInput): Promise<void> {
    try {
      await this.closeVolumeIntervals(
        input.volumeProviderId,
        input.startedAt ?? new Date(),
      );
      const entity = this.volumeIntervalRepo.create({
        clusterId: input.clusterId,
        volumeProviderId: input.volumeProviderId,
        provider: input.provider,
        region: input.region,
        kind: input.kind,
        sizeGb: input.sizeGb,
        startedAt: input.startedAt ?? new Date(),
        endedAt: null,
        metadata: {
          ...input.metadata,
          ...(await this.volumePrice(input.provider)),
        },
      });
      await this.volumeIntervalRepo.save(entity);
    } catch (err) {
      this.logger.warn(
        `openVolumeInterval failed for volume ${input.volumeProviderId}: ${(err as Error).message}`,
      );
    }
  }

  async closeVolumeIntervals(
    volumeProviderId: string,
    at: Date = new Date(),
  ): Promise<void> {
    try {
      await this.volumeIntervalRepo.update(
        { volumeProviderId, endedAt: IsNull() },
        { endedAt: at },
      );
    } catch (err) {
      this.logger.warn(
        `closeVolumeIntervals failed for ${volumeProviderId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Backfill: for every node and shared volume of every cluster without an
   * open interval, open one starting at the resource's createdAt. Idempotent —
   * called on app startup so pre-existing clusters become billable.
   */
  async backfillFromClusters(
    clusters: ClusterEntity[],
  ): Promise<{ nodes: number; volumes: number }> {
    let nodesOpened = 0;
    let volumesOpened = 0;
    for (const cluster of clusters) {
      for (const node of cluster.nodes ?? []) {
        const existing = await this.nodeIntervalRepo.findOne({
          where: { nodeId: node.id },
        });
        if (existing) continue;
        try {
          await this.nodeIntervalRepo.save(
            this.nodeIntervalRepo.create({
              clusterId: cluster.id,
              nodeId: node.id,
              serverName: node.serverName,
              providerResourceId: node.providerResourceId,
              provider: cluster.provider,
              region: cluster.region,
              serverType: cluster.nodeSize,
              nodeType: node.nodeType,
              startedAt: node.createdAt,
              endedAt: null,
              metadata: { backfilled: true },
            }),
          );
          nodesOpened++;
        } catch (err) {
          this.logger.warn(
            `backfill node ${node.id} failed: ${(err as Error).message}`,
          );
        }
      }

      if (cluster.sharedStorageVolumeId) {
        const existingVol = await this.volumeIntervalRepo.findOne({
          where: { volumeProviderId: cluster.sharedStorageVolumeId },
        });
        if (!existingVol) {
          try {
            await this.volumeIntervalRepo.save(
              this.volumeIntervalRepo.create({
                clusterId: cluster.id,
                volumeProviderId: cluster.sharedStorageVolumeId,
                provider: cluster.provider,
                region: cluster.region,
                kind: VolumeBillableKind.SHARED_STORAGE,
                sizeGb: cluster.sharedStorageVolumeSizeGb ?? 0,
                startedAt: cluster.createdAt,
                endedAt: null,
                metadata: { backfilled: true },
              }),
            );
            volumesOpened++;
          } catch (err) {
            this.logger.warn(
              `backfill volume ${cluster.sharedStorageVolumeId} failed: ${(err as Error).message}`,
            );
          }
        }
      }
    }
    return { nodes: nodesOpened, volumes: volumesOpened };
  }
}

void NodeType;
