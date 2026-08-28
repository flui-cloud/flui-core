import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AVAILABILITY_STATES,
  AvailabilityState,
  ShapeAvailability,
} from './catalogue.core';
import { CATALOGUE_HTTP, CatalogueHttp } from './catalogue-http';

const DEFAULT_BASE_URL = 'https://vops-api.flui.cloud';
const REQUEST_TIMEOUT_MS = 5_000;

/** One provider's stock, exactly as the catalogue served it. */
export interface CatalogueSnapshot {
  provider: string;
  /**
   * False when the catalogue carries the provider but publishes no
   * per-location stock for it. Empty lists then mean "nothing to say", not
   * "nothing available", and the two must not be told the same way.
   */
  published: boolean;
  shapes: ShapeAvailability[];
  /** Age at the moment the catalogue served it. Null when it did not say. */
  ageSeconds: number | null;
  staleAfterSeconds: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function regionList(
  value: unknown,
): { upIn: string[]; downIn: string[] } | null {
  if (!Array.isArray(value)) return null;
  const upIn: string[] = [];
  const downIn: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const code = entry.code;
    if (typeof code !== 'string' || typeof entry.up !== 'boolean') continue;
    (entry.up ? upIn : downIn).push(code);
  }
  return { upIn, downIn };
}

function limitedShape(value: unknown): ShapeAvailability | null {
  if (!isRecord(value)) return null;
  const plan = value.plan;
  if (typeof plan !== 'string' || !plan) return null;
  const regions = regionList(value.regions);
  if (!regions) return null;
  const state = AVAILABILITY_STATES.includes(value.status as AvailabilityState)
    ? (value.status as AvailabilityState)
    : null;
  if (!state) return null;
  return { shape: plan, state, everywhere: false, ...regions };
}

/**
 * Reads the two public endpoints of the hosted availability catalogue.
 *
 * Every failure — no answer, a slow answer, an answer that is not the shape
 * this expects — returns `null`, which means *we could not ask*. It never
 * returns an empty catalogue, because an empty catalogue is a claim about the
 * market and this has no grounds to make one.
 */
@Injectable()
export class VopsCatalogueClient {
  private readonly logger = new Logger(VopsCatalogueClient.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(CATALOGUE_HTTP) private readonly http: CatalogueHttp,
  ) {}

  /**
   * Declared and switchable: an installation that will not talk to anything it
   * does not run turns this off and scales on the instant reading alone.
   */
  get enabled(): boolean {
    return this.config.get<string>('VOPS_CATALOGUE_ENABLED') !== 'false';
  }

  private get baseUrl(): string {
    const configured = this.config.get<string>('VOPS_CATALOGUE_URL');
    return (configured || DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  /**
   * Which providers the catalogue carries at all, or null when it could not
   * be asked. Knowing a provider is absent saves a request that could only
   * answer nothing; not knowing rules nothing out.
   */
  async providers(): Promise<string[] | null> {
    const body = await this.get('/api/providers');
    if (!isRecord(body) || !Array.isArray(body.providers)) return null;
    const ids = body.providers
      .map((entry) =>
        isRecord(entry) && typeof entry.id === 'string' ? entry.id : null,
      )
      .filter((id): id is string => !!id);
    // An empty roster reads as "could not ask", never as "carries nobody":
    // the second would mark every provider uncovered on one bad response.
    return ids.length ? ids : null;
  }

  async availability(provider: string): Promise<CatalogueSnapshot | null> {
    const body = await this.get(
      `/api/availability?provider=${encodeURIComponent(provider)}`,
    );
    if (!isRecord(body)) return null;
    if (typeof body.live !== 'boolean') return null;
    if (!Array.isArray(body.limited) || !Array.isArray(body.everywhere)) {
      return null;
    }

    // A single unreadable row is dropped rather than failing the report: an
    // unnamed shape is one nothing here knows about, which excludes nothing,
    // while discarding the whole reading would throw away what was legible.
    const shapes = body.limited
      .map(limitedShape)
      .filter((shape): shape is ShapeAvailability => !!shape);
    for (const plan of body.everywhere) {
      if (typeof plan !== 'string' || !plan) continue;
      shapes.push({
        shape: plan,
        state: 'available',
        everywhere: true,
        upIn: [],
        downIn: [],
      });
    }

    const meta = isRecord(body.meta) ? body.meta : null;
    return {
      provider,
      published: body.live,
      shapes,
      ageSeconds: meta ? finiteNumber(meta.ageSeconds) : null,
      staleAfterSeconds: meta ? finiteNumber(meta.staleAfterSeconds) : null,
    };
  }

  private async get(path: string): Promise<unknown> {
    try {
      return await this.http.getJson(
        `${this.baseUrl}${path}`,
        REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      this.logger.debug(
        `availability catalogue unreachable at ${this.baseUrl}${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}
