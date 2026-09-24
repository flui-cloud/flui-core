interface HetznerLocation {
  name?: string;
  description?: string;
}

/**
 * Where a Hetzner server runs.
 *
 * Servers carry `location` directly; the `datacenter` wrapper it used to sit in
 * was removed from the API on 1 July 2026, and reading only that one answers
 * "unknown" for every server — which then prices and bills a new node against
 * a location that does not exist. The old shape is still read, for a response
 * that carries it.
 */
export function serverLocation(server: {
  location?: HetznerLocation | null;
  datacenter?: { location?: HetznerLocation | null } | null;
}): HetznerLocation | null {
  return server.location ?? server.datacenter?.location ?? null;
}
