interface Episode {
  fingerprint: string;
  startsAt: Date;
  status: 'firing' | 'resolved';
  annotations?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * The alert recorder as the database sees it: one episode per fingerprint and
 * start time, news only on a change of state, open episodes readable back.
 * Kept across "restarts" by reusing the same instance with a new service.
 */
export class FakeAlertEvents {
  readonly episodes: Episode[] = [];

  async record(
    batch: Episode[],
  ): Promise<Array<{ kind: 'fired' | 'resolved'; event: Episode }>> {
    const transitions: Array<{ kind: 'fired' | 'resolved'; event: Episode }> =
      [];
    for (const alert of batch) {
      const existing = this.episodes.find(
        (e) =>
          e.fingerprint === alert.fingerprint &&
          e.startsAt.getTime() === alert.startsAt.getTime(),
      );
      if (!existing) {
        this.episodes.push({ ...alert });
        if (alert.status === 'firing')
          transitions.push({ kind: 'fired', event: alert });
        continue;
      }
      const wasFiring = existing.status === 'firing';
      Object.assign(existing, alert);
      if (wasFiring && alert.status === 'resolved') {
        transitions.push({ kind: 'resolved', event: existing });
      }
    }
    return transitions;
  }

  async openEpisodes(prefix: string): Promise<Map<string, Date>> {
    return new Map(
      this.episodes
        .filter(
          (e) => e.status === 'firing' && e.fingerprint.startsWith(prefix),
        )
        .map((e) => [e.fingerprint, e.startsAt]),
    );
  }
}
