import { Injectable, Logger } from '@nestjs/common';

/**
 * Something that adds nodes without being asked, and the question it has to
 * answer about any one cluster.
 *
 * The predicate is the part that matters. Registering is a claim about the
 * installation — *something here can act* — and that alone would make every
 * cluster's status say a node arrives on its own, including the cluster nobody
 * configured and the provider nothing can buy from.
 */
export interface AutoscaleDriver {
  name: string;
  drives(clusterId: string): Promise<boolean>;
}

/**
 * Empty until something registers itself. `autoscale/status` and the capacity
 * gate read it to decide whether a node arrives on its own, so wiring a
 * reconciler changes what those two surfaces say — no sentence to edit by hand,
 * and no way for the claim to outlive the mechanism.
 */
@Injectable()
export class AutoscaleReconcilerRegistry {
  private readonly logger = new Logger(AutoscaleReconcilerRegistry.name);
  private readonly registered = new Map<string, AutoscaleDriver | null>();

  register(name: string, driver?: AutoscaleDriver): void {
    this.registered.set(name, driver ?? null);
    this.logger.log(`Autoscale reconciler registered: ${name}`);
  }

  /** True where anything at all is registered. Says nothing about any one cluster. */
  get driven(): boolean {
    return this.registered.size > 0;
  }

  /**
   * Whether a node would actually arrive on this cluster.
   *
   * A driver that cannot answer for a cluster is not counted for it: silence
   * here becomes a promise on the capacity gate, and the promise is the thing
   * this whole registry exists to keep honest.
   */
  async drivesCluster(clusterId: string): Promise<boolean> {
    for (const driver of this.registered.values()) {
      if (!driver) continue;
      try {
        if (await driver.drives(clusterId)) return true;
      } catch (err) {
        this.logger.warn(
          `Autoscale driver ${driver.name} could not answer for cluster ${clusterId}: ${(err as Error).message}`,
        );
      }
    }
    return false;
  }

  list(): string[] {
    return [...this.registered.keys()];
  }
}
