import { Injectable } from '@nestjs/common';
import { AvailabilityOutlookDto } from '../dto/scaling-response.dto';
import { AvailabilityCatalogueService } from './availability-catalogue.service';
import {
  CatalogueReading,
  CatalogueReadingState,
  ShapeAvailability,
  availabilityRank,
  unreadCatalogue,
  upWhereAllowed,
} from './catalogue.core';
import { OrderedShapeDto, ShapeCatalogueDto } from './dto/shape-catalogue.dto';

/** What ordering needs of a group, and nothing more. */
export interface OrderableGroup {
  id: string;
  provider: string;
  shapes: string[];
  regions: string[];
  capability: { hasCatalogue: boolean };
}

interface Candidate {
  shape: string;
  allowed: boolean;
  availability: ShapeAvailability | null;
  rank: number;
  preference: number;
}

/**
 * The group's allowed shapes, ordered by what the catalogue knows.
 *
 * Two rules hold the whole thing up. Nothing is ever removed — a shape the
 * catalogue calls sold out goes last, not away, because the provider decides at
 * the moment of purchase and the catalogue is a snapshot of somebody else's
 * observation. And the group's own preference is only ever broken by
 * availability: within shapes the catalogue says the same thing about, the
 * order written in the group survives untouched.
 *
 * Shapes the group may *not* buy come back too, marked. Naming a shape that is
 * up next to one that is gone is the catalogue informing; leaving it out would
 * be the catalogue quietly editing the group.
 */
@Injectable()
export class ShapeOrderingService {
  constructor(private readonly catalogue: AvailabilityCatalogueService) {}

  async order(group: OrderableGroup): Promise<ShapeCatalogueDto> {
    // Asked of the capability, never of the provider's name. Where the machines
    // arrive from the operator there is no market to read and there never will
    // be — a different answer from a market that came back empty.
    const reading = group.capability.hasCatalogue
      ? await this.catalogue.read(group.provider)
      : unreadCatalogue(group.provider, 'no-market');

    const candidates = this.candidates(group, reading);
    candidates.sort(byUsefulness);

    return {
      groupId: group.id,
      provider: group.provider,
      reading: reading.state,
      ageSeconds: reading.ageSeconds,
      stale: reading.stale,
      says: says(reading, group.provider),
      shapes: candidates.map((candidate) =>
        this.toDto(candidate, group.regions, reading.ageSeconds),
      ),
    };
  }

  private candidates(
    group: OrderableGroup,
    reading: CatalogueReading,
  ): Candidate[] {
    const allowed = group.shapes.map((shape, index) => ({
      shape,
      allowed: true,
      availability: this.catalogue.shapeIn(reading, shape),
      rank: 0,
      preference: index,
    }));

    const extra = reading.shapes
      .filter((entry) => !group.shapes.includes(entry.shape))
      .map((entry) => ({
        shape: entry.shape,
        allowed: false,
        availability: entry,
        rank: 0,
        preference: Number.MAX_SAFE_INTEGER,
      }));

    const all = [...allowed, ...extra];
    for (const candidate of all) {
      candidate.rank = availabilityRank(candidate.availability, group.regions);
    }
    return all;
  }

  private toDto(
    candidate: Candidate,
    regions: string[],
    ageSeconds: number | null,
  ): OrderedShapeDto {
    return {
      shape: candidate.shape,
      allowed: candidate.allowed,
      outlook: outlookOf(candidate.availability, regions, ageSeconds),
      why: why(candidate, regions),
    };
  }
}

/**
 * Best-known first, and the group's preference untouched inside each band.
 *
 * Allowed shapes stay ahead of shapes the group excluded: an availability
 * reading is not grounds to promote a purchase the group already refused.
 */
function byUsefulness(a: Candidate, b: Candidate): number {
  if (a.allowed !== b.allowed) return a.allowed ? -1 : 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.preference !== b.preference) return a.preference - b.preference;
  return a.shape.localeCompare(b.shape);
}

/**
 * `sinceHours` stays null on purpose: how long a state has held is a history of
 * transitions, and the public reading carries only the present one. Filling it
 * from the current snapshot would be a number with nothing behind it.
 */
function outlookOf(
  availability: ShapeAvailability | null,
  regions: string[],
  ageSeconds: number | null,
): AvailabilityOutlookDto | null {
  if (!availability) return null;
  return {
    state: availability.state,
    // "Up everywhere" arrives with its region list dropped, so it is projected
    // onto the regions that were asked about rather than rendered as an empty
    // list somebody would read as "up nowhere".
    upIn: availability.everywhere ? regions : availability.upIn,
    downIn: availability.downIn,
    sinceHours: null,
    ageSeconds,
  };
}

function why(candidate: Candidate, regions: string[]): string {
  const excluded = candidate.allowed ? '' : ' This group may not buy it.';
  const availability = candidate.availability;
  if (!availability) {
    return `The catalogue does not name it, which rules nothing out.${excluded}`;
  }
  if (availability.everywhere) {
    return `Up in every region the catalogue covers.${excluded}`;
  }
  const up = upWhereAllowed(availability, regions);
  if (up.length) {
    return `Up in ${up.join(', ')}.${excluded}`;
  }
  const elsewhere = availability.upIn.length
    ? ` Up in ${availability.upIn.join(', ')}, where this group may not buy.`
    : '';
  return `Down where this group may buy.${elsewhere}${excluded}`;
}

const SAYS: Record<CatalogueReadingState, (provider: string) => string> = {
  read: () =>
    'Ordered by an availability reading. It orders candidates and decides nothing — the provider accepts or refuses the purchase.',
  'not-published': (provider) =>
    `The catalogue carries ${provider} but publishes no per-location stock for it, so this is the group's own order of preference.`,
  'not-covered': (provider) =>
    `The catalogue does not cover ${provider}, so this is the group's own order of preference.`,
  unreachable: () =>
    'The catalogue did not answer. Nothing is ruled out by that, so this is the group’s own order of preference.',
  'no-market': () =>
    'These machines are the operator’s own. There is no market to read here, which is not the same as a market that came back empty.',
  off: () =>
    'The availability catalogue is switched off on this installation, so this is the group’s own order of preference.',
};

function says(reading: CatalogueReading, provider: string): string {
  return SAYS[reading.state](provider);
}
