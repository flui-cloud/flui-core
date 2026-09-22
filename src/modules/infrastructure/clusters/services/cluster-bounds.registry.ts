import { Injectable, Logger } from '@nestjs/common';

/** The floor and ceiling a cluster may not cross, counted across every node. */
export interface ClusterBounds {
  min: number | null;
  max: number | null;
}

/**
 * Something that owns a cluster's bounds, and the question it answers about
 * any one cluster.
 *
 * Silence is a real answer here: a cluster this source knows nothing about
 * keeps the bounds stored on the cluster row, which is how installations that
 * never set scaling up carry on unchanged.
 */
export interface ClusterBoundsSource {
  name: string;
  boundsFor(clusterId: string): Promise<ClusterBounds | null>;
  /**
   * Takes a floor and ceiling set elsewhere, and reports whether it owns them.
   * Without this, a limit raised through the older cluster route would be
   * stored where nothing reads it — a number that looks set and does nothing.
   */
  writeBounds?(clusterId: string, bounds: ClusterBounds): Promise<boolean>;
}

/**
 * Empty until something registers itself.
 *
 * Adding and removing nodes is fenced by these numbers, and two sets of them —
 * one on the cluster, one on a scaling group — is how a ceiling gets raised in
 * one place and enforced from the other. Whoever owns the figure registers
 * here, and the fence follows it.
 */
@Injectable()
export class ClusterBoundsRegistry {
  private readonly logger = new Logger(ClusterBoundsRegistry.name);
  private readonly sources = new Map<string, ClusterBoundsSource>();

  register(source: ClusterBoundsSource): void {
    this.sources.set(source.name, source);
    this.logger.log(`Cluster bounds source registered: ${source.name}`);
  }

  /**
   * The bounds in force for this cluster, or null where nothing owns them.
   *
   * A source that cannot answer is passed over rather than treated as "no
   * limits": losing a fence is worse than consulting the next source.
   */
  async boundsFor(clusterId: string): Promise<ClusterBounds | null> {
    for (const source of this.sources.values()) {
      try {
        const bounds = await source.boundsFor(clusterId);
        if (bounds) return bounds;
      } catch (err) {
        this.logger.warn(
          `Bounds source ${source.name} could not answer for cluster ${clusterId}: ${(err as Error).message}`,
        );
      }
    }
    return null;
  }

  /** Hands the bounds to whoever owns them. False where nobody does. */
  async writeBounds(
    clusterId: string,
    bounds: ClusterBounds,
  ): Promise<boolean> {
    for (const source of this.sources.values()) {
      if (!source.writeBounds) continue;
      try {
        if (await source.writeBounds(clusterId, bounds)) return true;
      } catch (err) {
        this.logger.warn(
          `Bounds source ${source.name} could not take bounds for cluster ${clusterId}: ${(err as Error).message}`,
        );
        throw err;
      }
    }
    return false;
  }

  list(): string[] {
    return [...this.sources.keys()];
  }
}
