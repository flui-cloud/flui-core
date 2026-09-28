import { Injectable, Logger } from '@nestjs/common';
import { ProviderFactory } from '../../../providers/core/factories/provider.factory';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { NodeSizeDto } from '../../../providers/dto/node-size.dto';
import { withTimeout } from '../../shared/utils/with-timeout.util';
import { ShapeFact, ShapeFactsReading } from './engine.core';

/**
 * How long a reading is reused. Short, because availability is part of it: a
 * machine sold out an hour ago may be back, and one on offer an hour ago may be
 * gone — a purchase decided on either is the wrong one.
 */
const HOLD_MS = 5 * 60 * 1000;

/**
 * How long a pass or a preview waits for the provider's sizes. OVH asks every
 * region it has for its flavors, and one slow region held a preview for over
 * two minutes. A read that misses this keeps running and fills the reading
 * for the next caller, which then answers at once.
 */
export const SHAPES_DEADLINE_MS = 10_000;

interface Held {
  reading: ShapeFactsReading;
  atMs: number;
}

/**
 * What each shape holds and what it costs, from the provider's own catalogue.
 *
 * Availability comes with it, and is the authority. It costs nothing extra —
 * the provider returns it in the same response as the shapes and the prices,
 * which this pass already fetches — and it is authenticated and live, where the
 * outside catalogue is neither. Reading one and discarding the other put a
 * third party's cache in charge of whether a stuck pod could be answered.
 *
 * A catalogue nobody could read comes back as `read: false` and never as an
 * empty one — the difference between "this provider sells nothing that fits"
 * and "nobody could ask" is the whole content of a decline.
 */
@Injectable()
export class ShapeFactsService {
  private readonly logger = new Logger(ShapeFactsService.name);
  private readonly held = new Map<string, Held>();
  private readonly inFlight = new Map<string, Promise<ShapeFactsReading>>();

  constructor(private readonly providers: ProviderFactory) {}

  async read(provider: string): Promise<ShapeFactsReading> {
    const held = this.held.get(provider);
    if (held && Date.now() - held.atMs < HOLD_MS) {
      return {
        ...held.reading,
        ageSeconds: Math.round((Date.now() - held.atMs) / 1000),
      };
    }

    const reading = await withTimeout(
      this.fetchOnce(provider),
      SHAPES_DEADLINE_MS,
    );
    if (!reading) {
      this.logger.warn(
        `Shape catalogue for ${provider} did not answer in ${SHAPES_DEADLINE_MS}ms; still reading it for the next caller`,
      );
      return { shapes: [], read: false };
    }
    return { ...reading, ageSeconds: 0 };
  }

  private fetchOnce(provider: string): Promise<ShapeFactsReading> {
    const running = this.inFlight.get(provider);
    if (running !== undefined) return running;
    const fetching = this.fetch(provider)
      .then((reading) => {
        // A failed read is not cached: the next tick should ask again rather
        // than repeat an hour of "could not say".
        if (reading.read) {
          this.held.set(provider, { reading, atMs: Date.now() });
        }
        return reading;
      })
      .finally(() => this.inFlight.delete(provider));
    this.inFlight.set(provider, fetching);
    return fetching;
  }

  private async fetch(provider: string): Promise<ShapeFactsReading> {
    try {
      const service = this.providers.getProvider(provider as CloudProvider);
      if (!service.getNodeSizes) return { shapes: [], read: false };
      const sizes = await service.getNodeSizes(true);
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
    architecture:
      size.architecture === 'arm' || size.architecture === 'x86'
        ? size.architecture
        : null,
    availability: size.availability
      ? size.availability.map((entry) => ({
          region: entry.location,
          up: entry.available,
        }))
      : null,
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
