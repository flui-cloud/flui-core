import { SiteRoundTrip } from './site-round-trip.core';

/** What the high availability sweep last saw on a cluster, kept in its metadata. */
export interface HaObserved {
  at: string;
  etcdLeader: { node: string | null; zone: string | null } | null;
  roundTrips: SiteRoundTrip[];
  etcdLeaderMovedAt?: string;
}
