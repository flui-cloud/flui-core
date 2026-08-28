import { Injectable, Logger } from '@nestjs/common';
import { ProviderFactory } from '../../../providers/core/factories/provider.factory';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { NodeSizeDto } from '../../../providers/dto/node-size.dto';
import { ShapeFact, ShapeFactsReading } from './engine.core';

const HOLD_MS = 60 * 60 * 1000;

interface Held {
  reading: ShapeFactsReading;
  atMs: number;
}

/**
 * What each shape holds and what it costs, from the provider's own catalogue.
 *
 * Availability is deliberately not asked for here: the reading that says
 * whether a shape can be had right now belongs to the availability catalogue,
 * and asking the provider for it turns a decision loop into a call per tick on
 * somebody's credentials.
 *
 * A catalogue nobody could read comes back as `read: false` and never as an
 * empty one — the difference between "this provider sells nothing that fits"
 * and "nobody could ask" is the whole content of a decline.
 */
@Injectable()
export class ShapeFactsService {
  private readonly logger = new Logger(ShapeFactsService.name);
  private readonly held = new Map<string, Held>();

  constructor(private readonly providers: ProviderFactory) {}

  async read(provider: string): Promise<ShapeFactsReading> {
    const held = this.held.get(provider);
    if (held && Date.now() - held.atMs < HOLD_MS) return held.reading;

    const reading = await this.fetch(provider);
    // A failed read is not cached: the next tick should ask again rather than
    // repeat an hour of "could not say".
    if (reading.read) this.held.set(provider, { reading, atMs: Date.now() });
    return reading;
  }

  private async fetch(provider: string): Promise<ShapeFactsReading> {
    try {
      const service = this.providers.getProvider(provider as CloudProvider);
      if (!service.getNodeSizes) return { shapes: [], read: false };
      const sizes = await service.getNodeSizes(false);
      return { shapes: sizes.map(toFact), read: true };
    } catch (err) {
      this.logger.warn(
        `Shape catalogue unavailable for ${provider}: ${(err as Error).message}`,
      );
      return { shapes: [], read: false };
    }
  }
}

function toFact(size: NodeSizeDto): ShapeFact {
  return {
    shape: size.name || size.id,
    cores: size.cores,
    memoryMi: Math.round(size.memory * 1024),
    deprecated: size.deprecated,
    supportsHourlyBilling: size.supportsHourlyBilling,
    prices: (size.prices ?? []).map((price) => ({
      region: price.location,
      hourlyEur: euro(price.priceHourly?.net),
      monthlyEur: euro(price.priceMonthly?.net),
    })),
  };
}

function euro(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
