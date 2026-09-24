import { NodeSizeLocationAvailabilityDto } from '../../dto/node-size.dto';

/** One location of a server type, as Hetzner reports it since April 2026. */
interface ServerTypeLocation {
  name: string;
  deprecation?: unknown;
  available?: boolean;
  recommended?: boolean;
}

/**
 * Whether a server type can be bought in each of its locations, read from the
 * server type itself.
 *
 * Hetzner moved this onto `server_types[].locations[]` and retires the
 * datacenter endpoint it used to live on after 1 October 2026; the old list
 * already leaves out the newest types, which read as sold out everywhere while
 * they can be bought. Where a location carries no answer it is reported as
 * unknown rather than as unavailable.
 */
export function serverTypeAvailability(serverType: {
  locations?: ServerTypeLocation[];
}): NodeSizeLocationAvailabilityDto[] {
  return (serverType.locations ?? []).map((location) => {
    const known = typeof location.available === 'boolean';
    return {
      location: location.name,
      available: known ? Boolean(location.available) : true,
      availabilityKnown: known,
      deprecated: Boolean(location.deprecation),
    };
  });
}
