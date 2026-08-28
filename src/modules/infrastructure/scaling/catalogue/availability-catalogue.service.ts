import { Injectable } from '@nestjs/common';
import {
  CatalogueReading,
  ShapeAvailability,
  unreadCatalogue,
} from './catalogue.core';
import {
  CatalogueSnapshot,
  VopsCatalogueClient,
} from './vops-catalogue.client';

/**
 * Availability moves; a screen render should still be one request. Long enough
 * that a page costs one call, short enough that the reading is never badly out
 * of date — and the age is reported either way, so the number is a courtesy
 * rather than a claim.
 */
const HOLD_SECONDS = 60;

interface Held {
  snapshot: CatalogueSnapshot;
  fetchedAtMs: number;
}

/**
 * Holds the catalogue's answer in memory and ages it out loud.
 *
 * Held rather than refreshed on a schedule: the only job on a timer in this
 * part of the product is the firewall reconciler, and the autoscale status says
 * so to whoever reads it. A second one would make the product wrong about
 * itself for the sake of a number that has to carry its age anyway.
 *
 * An old reading is still a reading and is served as one, with the time it sat
 * here added to the age the catalogue reported. What is never served is a
 * fresh-looking substitute for a reading nobody took.
 */
@Injectable()
export class AvailabilityCatalogueService {
  private readonly held = new Map<string, Held>();
  private readonly inFlight = new Map<string, Promise<Held | null>>();
  private roster: { ids: string[]; atMs: number } | null = null;

  constructor(private readonly client: VopsCatalogueClient) {}

  async read(provider: string): Promise<CatalogueReading> {
    if (!this.client.enabled) return unreadCatalogue(provider, 'off');

    if (await this.uncovered(provider)) {
      return unreadCatalogue(provider, 'not-covered');
    }

    const held = await this.snapshot(provider);
    if (!held) return unreadCatalogue(provider, 'unreachable');

    const ageSeconds = agedBy(held);
    const stale =
      ageSeconds !== null &&
      held.snapshot.staleAfterSeconds !== null &&
      ageSeconds > held.snapshot.staleAfterSeconds;

    if (!held.snapshot.published) {
      return {
        provider,
        state: 'not-published',
        shapes: [],
        ageSeconds,
        stale,
      };
    }

    return {
      provider,
      state: 'read',
      shapes: held.snapshot.shapes,
      ageSeconds,
      stale,
    };
  }

  shapeIn(reading: CatalogueReading, shape: string): ShapeAvailability | null {
    return reading.shapes.find((entry) => entry.shape === shape) ?? null;
  }

  /**
   * True only when the roster came back and left this provider out. A roster
   * nobody could read answers "we do not know", which is not a reason to skip
   * asking.
   */
  private async uncovered(provider: string): Promise<boolean> {
    if (this.roster && !expired(this.roster.atMs)) {
      return !this.roster.ids.includes(provider);
    }
    const ids = await this.client.providers();
    if (!ids) return false;
    this.roster = { ids, atMs: Date.now() };
    return !ids.includes(provider);
  }

  private async snapshot(provider: string): Promise<Held | null> {
    const held = this.held.get(provider);
    if (held && !expired(held.fetchedAtMs)) return held;

    const running = this.inFlight.get(provider);
    if (running) return running;

    const fetching = this.fetch(provider).finally(() =>
      this.inFlight.delete(provider),
    );
    this.inFlight.set(provider, fetching);
    return fetching;
  }

  private async fetch(provider: string): Promise<Held | null> {
    const snapshot = await this.client.availability(provider);
    if (!snapshot) return this.held.get(provider) ?? null;
    const fresh = { snapshot, fetchedAtMs: Date.now() };
    this.held.set(provider, fresh);
    return fresh;
  }
}

const expired = (atMs: number): boolean =>
  Date.now() - atMs > HOLD_SECONDS * 1000;

/**
 * The catalogue's own age plus the time this held it.
 *
 * Unknown stays unknown: there is no age to add to, and inventing one here
 * would be the whole failure this exists to avoid.
 */
function agedBy(held: Held): number | null {
  if (held.snapshot.ageSeconds === null) return null;
  const heldSeconds = Math.max(
    0,
    Math.round((Date.now() - held.fetchedAtMs) / 1000),
  );
  return held.snapshot.ageSeconds + heldSeconds;
}
