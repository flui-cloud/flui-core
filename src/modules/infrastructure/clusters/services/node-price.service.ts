import { Injectable, Logger } from '@nestjs/common';
import { ProviderFactory } from '../../../providers/core/factories/provider.factory';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { NodeSizeDto } from '../../../providers/dto/node-size.dto';

const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Hourly price of one node, or null. Never a number the caller has to guess at:
 * a provider without a catalogue, an unknown size and a failed lookup all
 * answer null, so a node row that carries a price carries a real one.
 */
@Injectable()
export class NodePriceService {
  private readonly logger = new Logger(NodePriceService.name);
  private cache: {
    provider: CloudProvider;
    fetchedAt: number;
    sizes: NodeSizeDto[];
  } | null = null;

  constructor(private readonly providerFactory: ProviderFactory) {}

  async resolveHourlyEur(
    provider: string,
    serverType?: string | null,
    location?: string | null,
  ): Promise<number | null> {
    if (!serverType) return null;

    const sizes = await this.loadSizes(provider as CloudProvider);
    const size = sizes.find(
      (s) => s.name === serverType || s.id === serverType,
    );
    if (!size?.prices?.length) return null;

    const match = location
      ? size.prices.find((p) => p.location === location)
      : undefined;
    const raw = (match ?? size.prices[0]).priceHourly?.net;
    if (!raw) return null;

    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private async loadSizes(provider: CloudProvider): Promise<NodeSizeDto[]> {
    const now = Date.now();
    if (
      this.cache?.provider === provider &&
      now - this.cache.fetchedAt < CACHE_TTL_MS
    ) {
      return this.cache.sizes;
    }

    let sizes: NodeSizeDto[] = [];
    try {
      const service = this.providerFactory.getProvider(provider);
      if (service.getNodeSizes) {
        sizes = await service.getNodeSizes(false);
      }
    } catch (err) {
      this.logger.warn(
        `Node prices unavailable for ${provider}: ${(err as Error).message}`,
      );
    }

    this.cache = { provider, fetchedAt: now, sizes };
    return sizes;
  }
}
