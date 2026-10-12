import { Logger } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity';
import { ClusterDnsZoneEntity } from '../../dns/entities/cluster-dns-zone.entity';
import { AppEndpointReconciliationService } from '../../dns/services/app-endpoint-reconciliation.service';
import { MigrationBridgeState } from '../../dns/interfaces/migration-bridge.interface';
import { sameValues } from '../../dns/utils/ingress-addresses.core';
import { describeError } from '../../shared/utils/error.util';
import { AppMigrationEntity } from '../entities/app-migration.entity';

export interface RouteTimings {
  retryDelayMs: number;
  reconcileAttempts: number;
  readBackAttempts: number;
  readBackDelayMs: number;
}

/** The migration's hold on its endpoints: where they are bound, their routes and their DNS. */
export class AppMigrationRoutes {
  constructor(
    private readonly endpointRepo: Repository<AppEndpointEntity>,
    private readonly zoneRepo: Repository<ClusterDnsZoneEntity>,
    private readonly endpointReconciliation: AppEndpointReconciliationService,
    private readonly logger: Logger,
    private readonly timings: RouteTimings,
  ) {}

  async removeSourceRoutes(
    mig: AppMigrationEntity,
    endpoints: AppEndpointEntity[],
    keepCertificate: boolean,
    warnings: string[],
  ): Promise<void> {
    for (const ep of endpoints) {
      await this.endpointReconciliation
        .deleteEndpointResources(ep.id, {
          clusterId: mig.srcClusterId,
          keepCertificate,
        })
        .catch((e: unknown) =>
          warnings.push(
            `the route of ${ep.fqdn} on the source was not removed: ${describeError(e)}`,
          ),
        );
    }
  }

  async reconcileRoutes(endpoints: AppEndpointEntity[]): Promise<void> {
    for (const ep of endpoints) {
      if (!(await this.reconcileUntilDone(ep.id))) {
        throw new Error(
          `The route for ${ep.fqdn} could not be built on its cluster: another reconcile kept running`,
        );
      }
    }
  }

  /**
   * Another application may have taken a path on one of these names since the
   * migration was created; moving the name would strand it. Checked again
   * before anything moves.
   */
  async assertHostsStillOwn(app: ApplicationEntity): Promise<void> {
    const endpoints = await this.endpointRepo.find({
      where: { applicationId: app.id },
    });
    if (endpoints.length === 0) return;
    const own = new Set(endpoints.map((e) => e.id));
    const sharing = (
      await this.endpointRepo.find({
        where: { fqdn: In([...new Set(endpoints.map((e) => e.fqdn))]) },
      })
    ).filter((e) => !own.has(e.id) && e.applicationId !== app.id);
    if (sharing.length) {
      const other = sharing[0];
      throw new Error(
        `${other.fqdn} now also routes ${other.routePath ?? '/'} to application ${other.applicationId}, which is not moving; nothing was moved. Give one of them its own hostname, then run the cutover again.`,
      );
    }
  }

  /**
   * Endpoints follow the app into the destination's assignment of the same
   * DNS zone: left in the source's, the source's ingress reconciler would pull
   * the name back whenever the source's nodes change.
   */
  async rebindEndpoints(
    endpoints: AppEndpointEntity[],
    clusterId: string,
    holdBy: string | null,
  ): Promise<void> {
    for (const ep of endpoints) {
      const patch: Partial<AppEndpointEntity> = {
        clusterId,
        clusterDnsZoneId: await this.assignmentOn(
          ep.clusterDnsZoneId,
          clusterId,
        ),
        dnsHeldBy: holdBy,
        dnsRecordValue: null,
      };
      if (ep.clusterId !== clusterId && ep.wildcardCertificateId) {
        patch.wildcardCertificateId = null;
        patch.tlsSecretName = null;
      }
      await this.endpointRepo.update(ep.id, patch);
      Object.assign(ep, patch);
    }
  }

  private async assignmentOn(
    assignmentId: string | null | undefined,
    clusterId: string,
  ): Promise<string | null> {
    if (!assignmentId) return null;
    const current = await this.zoneRepo.findOne({
      where: { id: assignmentId },
    });
    if (!current || current.clusterId === clusterId) return assignmentId;
    const there = await this.zoneRepo.findOne({
      where: { clusterId, dnsZoneId: current.dnsZoneId },
    });
    if (!there) {
      throw new Error(
        `Cluster ${clusterId} has no assignment for the DNS zone ${current.dnsZone?.zoneName ?? current.dnsZoneId}`,
      );
    }
    return there.id;
  }

  /**
   * Moves each name to its endpoint's cluster and reads the provider back: a
   * reconcile skipped because another was running is retried, and a record
   * still answering with the old addresses is reported, never called a move.
   */
  async flipDns(
    endpoints: AppEndpointEntity[],
  ): Promise<{ problems: string[]; ttl: number | null }> {
    const problems: string[] = [];
    let ttl: number | null = null;
    for (const ep of endpoints) {
      try {
        const before = await this.endpointReconciliation
          .publishedAnswer(ep.id)
          .catch(() => null);
        if (before?.ttl) ttl = Math.max(ttl ?? 0, before.ttl);
        if (ep.dnsHeldBy) {
          await this.endpointRepo.update(ep.id, {
            dnsHeldBy: null,
            dnsRecordValue: null,
          });
          ep.dnsHeldBy = null;
        }
        const done = await this.reconcileUntilDone(ep.id, {
          nameAlreadyPublished: true,
        });
        if (!done) {
          problems.push(
            `${ep.fqdn}: another reconcile kept running, DNS was not moved`,
          );
          continue;
        }
        let after = await this.endpointReconciliation.publishedAnswer(ep.id);
        for (
          let read = 1;
          after &&
          !sameValues(after.published, after.expected) &&
          read < this.timings.readBackAttempts;
          read++
        ) {
          await new Promise((r) => setTimeout(r, this.timings.readBackDelayMs));
          after = await this.endpointReconciliation.publishedAnswer(ep.id);
        }
        if (after && !sameValues(after.published, after.expected)) {
          problems.push(
            `${ep.fqdn} still answers ${after.published.join(', ') || 'nothing'} instead of ${after.expected.join(', ')}`,
          );
        }
      } catch (e: unknown) {
        problems.push(`${ep.fqdn}: ${describeError(e)}`);
      }
    }
    return { problems, ttl };
  }

  /** `reconcile` answers false, without doing anything, while another run holds the endpoint. */
  private async reconcileUntilDone(
    endpointId: string,
    options?: { nameAlreadyPublished?: boolean },
  ): Promise<boolean> {
    for (let attempt = 0; attempt < this.timings.reconcileAttempts; attempt++) {
      const ran = await this.endpointReconciliation.reconcile(
        endpointId,
        options,
      );
      if (ran !== false) return true;
      await new Promise((r) => setTimeout(r, this.timings.retryDelayMs));
    }
    return false;
  }

  /** Builds every bridged route on the destination ahead of the cutover; false leaves it to the cutover. */
  async prepareRoutes(
    mig: AppMigrationEntity,
    hosts: MigrationBridgeState['hosts'],
  ): Promise<boolean> {
    try {
      for (const host of hosts) {
        for (const endpointId of host.endpointIds) {
          await this.endpointReconciliation.prepareRouteOn(
            endpointId,
            mig.targetClusterId,
            host.secretName,
          );
        }
      }
      return true;
    } catch (err: unknown) {
      this.logger.warn(
        `[app-migration] ${mig.id}: destination route not prepared, the cutover builds it: ${describeError(err)}`,
      );
      return false;
    }
  }
}
