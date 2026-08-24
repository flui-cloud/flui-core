import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { SandboxTenantEntity } from '../../sandbox/entities/sandbox-tenant.entity';
import { ClusterDnsZoneEntity } from '../entities/cluster-dns-zone.entity';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';
import { DnsRecordType } from '../../providers/interfaces/dns-provider.interface';
import { SandboxSubdomainConfigService } from './sandbox-subdomain-config.service';
import { WildcardCertificateService } from './wildcard-certificate.service';
import { DnsZoneReconciliationService } from './dns-zone-reconciliation.service';
import {
  buildSharedSubdomain,
  sharedWildcardRecordName,
} from '../utils/shared-subdomain.util';

/**
 * The one subdomain every sandbox tenancy publishes under — `demo.<zone>` by
 * default — and the single certificate and single DNS record that serve all of
 * them.
 *
 * **The rule this exists to keep:** the number of certificates an installation
 * issues is a constant of the installation, never a function of how many
 * guests pass through it. Hundreds of guests share `*.demo.<zone>`; a hundred
 * and first costs nothing. That is why the shape here is one name for
 * everybody and not one name each — see `TenancySubdomainService`, which is
 * the per-tenancy shape and is excluded by that same rule.
 *
 * **A name is only used once its certificate is valid.** Until then a tenancy
 * keeps publishing under the shared `<cluster>.<zone>`, which the cluster's
 * existing wildcard already answers for. A hostname is written once and lived
 * with, so moving the name before the certificate lands means handing the
 * first visitor an `https://` link the browser refuses for as long as the ACME
 * order takes — and a name nobody can move afterwards.
 *
 * Off by default. An installation that does not set `FLUI_SANDBOX_SUBDOMAIN`
 * behaves exactly as it does today, line for line.
 */
@Injectable()
export class SandboxSubdomainService {
  private readonly logger = new Logger(SandboxSubdomainService.name);

  constructor(
    private readonly config: SandboxSubdomainConfigService,
    @InjectRepository(SandboxTenantEntity)
    private readonly sandboxTenants: Repository<SandboxTenantEntity>,
    @InjectRepository(ClusterDnsZoneEntity)
    private readonly clusterDnsZones: Repository<ClusterDnsZoneEntity>,
    private readonly wildcardCertificates: WildcardCertificateService,
    private readonly zoneRecords: DnsZoneReconciliationService,
  ) {}

  isEnabled(): boolean {
    return this.config.isEnabled();
  }

  /**
   * The name this tenancy would publish under in the given zone, whether or not
   * the certificate exists yet. Null when the feature is off, when this is not
   * the cluster the shared subdomain belongs to, when the namespace is not a
   * sandbox tenancy, or when the parts do not make a hostname.
   */
  async nominalSubdomain(
    cluster: ClusterEntity,
    namespace: string,
    zoneName: string,
  ): Promise<string | null> {
    if (!this.config.ownsCluster(cluster.id)) return null;
    if (!(await this.isTenancy(cluster.id, namespace))) return null;
    return buildSharedSubdomain({ label: this.config.label(), zoneName });
  }

  /**
   * The same name, but only once `*.<label>.<zone>` is valid on this cluster.
   * Null means "keep the shared cluster name", which is the answer until the
   * one certificate lands and the answer forever if it never does.
   */
  async activeSubdomain(
    cluster: ClusterEntity,
    namespace: string,
    zoneName: string,
  ): Promise<string | null> {
    const subdomain = await this.nominalSubdomain(cluster, namespace, zoneName);
    if (!subdomain) return null;
    return (await this.certificateIsValid(cluster.id, subdomain))
      ? subdomain
      : null;
  }

  /**
   * Every subdomain a tenancy currently publishes under, across the zones the
   * cluster serves — the space a hostname claim has to fall inside.
   *
   * Empty until the certificate is valid, and the caller then falls back to the
   * cluster-wide subdomain: that really is the space a tenancy has until the
   * shared one is served, and refusing it would leave a guest with no name at
   * all.
   */
  async activeSubdomains(
    cluster: ClusterEntity,
    namespace: string,
  ): Promise<string[]> {
    if (!this.config.ownsCluster(cluster.id)) return [];
    if (!(await this.isTenancy(cluster.id, namespace))) return [];

    const label = this.config.label();
    const active: string[] = [];
    for (const zoneName of await this.zoneNames(cluster.id)) {
      const subdomain = buildSharedSubdomain({ label, zoneName });
      if (!subdomain) continue;
      if (await this.certificateIsValid(cluster.id, subdomain)) {
        active.push(subdomain);
      }
    }
    return active;
  }

  /**
   * Put the two things the shared subdomain needs in place: the record
   * `*.<label>` on the zone, and the certificate `*.<label>.<zone>`.
   *
   * **Called while a tenancy is being provisioned**, not at boot and not on a
   * zone reconcile. Boot has no cluster to work on until the sandbox is
   * configured and running; a zone reconcile only visits zones that have a
   * replica, which most do not. Provisioning is the one path that always runs
   * before a guest exists, has the cluster in hand, and can afford to wait —
   * it is a background refill, not a visitor watching a spinner.
   *
   * **Cheap after the first.** Once the certificate row says VALID this does no
   * cluster and no provider work at all, so the hundredth tenancy costs a
   * single query. The Secret still reaches each namespace, but by the ordinary
   * endpoint path (`ensureForEndpoint` resolves the same scope), not from here.
   *
   * **Never throws.** A tenancy without the shared name is a tenancy on the
   * cluster name, which is where every tenancy is today.
   */
  async ensure(
    cluster: ClusterEntity,
    namespace: string,
  ): Promise<{ subdomain: string; ready: boolean } | null> {
    if (!this.config.isEnabled()) return null;
    if (!this.config.ownsCluster(cluster.id)) {
      this.logger.warn(
        `[sandbox-subdomain] cluster ${cluster.id} is not the configured sandbox cluster — keeping the cluster name`,
      );
      return null;
    }

    const assignment = await this.primaryAssignment(cluster.id);
    const zoneName = assignment?.dnsZone?.zoneName;
    if (!assignment || !zoneName) return null;

    const label = this.config.label();
    const subdomain = buildSharedSubdomain({ label, zoneName });
    if (!subdomain) {
      this.logger.warn(
        `[sandbox-subdomain] "${label}.${zoneName}" is not a hostname — keeping the cluster name`,
      );
      return null;
    }

    await this.publishRecord(cluster, assignment, label);

    // The certificate is the installation's, not the tenancy's: ask for it once
    // and read the answer thereafter.
    const existing = await this.wildcardCertificates.getByScope(
      cluster.id,
      subdomain,
    );
    if (existing?.status === CertificateStatus.VALID) {
      return { subdomain, ready: true };
    }

    try {
      const result = await this.wildcardCertificates.ensureForScope(
        cluster.id,
        subdomain,
        namespace,
      );
      if (!result) {
        this.logger.log(
          `[sandbox-subdomain] no wildcard available for *.${subdomain} — keeping the cluster name`,
        );
        return null;
      }
      this.logger.log(
        `[sandbox-subdomain] *.${subdomain} ${result.ready ? 'is valid' : 'is still issuing'}`,
      );
      return { subdomain, ready: result.ready };
    } catch (err) {
      this.logger.warn(
        `[sandbox-subdomain] could not issue *.${subdomain}: ${
          err instanceof Error ? err.message : String(err)
        } — keeping the cluster name`,
      );
      return null;
    }
  }

  /**
   * `*.<label>` → the cluster's address. One record for every application every
   * guest will ever deploy: `wildcardCoveringRecord` finds it one label above
   * each new name and stops writing per-application records by itself.
   *
   * Best-effort — a tenancy whose record is missing still resolves through the
   * per-application records the endpoint path falls back to writing.
   */
  private async publishRecord(
    cluster: ClusterEntity,
    assignment: ClusterDnsZoneEntity,
    label: string,
  ): Promise<void> {
    const name = sharedWildcardRecordName(label);
    const value = cluster.masterIpAddress;
    if (!name || !value || !assignment.dnsZone) return;

    try {
      await this.zoneRecords.ensureWildcardRecord(assignment.dnsZone, {
        name,
        type: DnsRecordType.A,
        value,
        ttl: assignment.dnsZone.recordTtlSeconds,
      });
    } catch (err) {
      this.logger.warn(
        `[sandbox-subdomain] could not publish ${name}.${assignment.dnsZone.zoneName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * The zone the shared subdomain lives in. Sorted by name and never by
   * insertion order: a second API instance, or a retry after a restart, has to
   * pick the same zone or the installation ends up with two certificates and
   * uses neither name.
   */
  private async primaryAssignment(
    clusterId: string,
  ): Promise<ClusterDnsZoneEntity | null> {
    const assignments = await this.clusterDnsZones.find({
      where: { clusterId },
      relations: ['dnsZone'],
    });
    return (
      assignments
        .filter((assignment) => !!assignment.dnsZone?.zoneName)
        .sort((a, b) =>
          a.dnsZone.zoneName.localeCompare(b.dnsZone.zoneName),
        )[0] ?? null
    );
  }

  private async zoneNames(clusterId: string): Promise<string[]> {
    const assignments = await this.clusterDnsZones.find({
      where: { clusterId },
      relations: ['dnsZone'],
    });
    return assignments
      .map((assignment) => assignment.dnsZone?.zoneName)
      .filter((name): name is string => !!name);
  }

  private async isTenancy(
    clusterId: string,
    namespace: string,
  ): Promise<boolean> {
    return await this.sandboxTenants.exists({
      where: { clusterId, namespace },
    });
  }

  private async certificateIsValid(
    clusterId: string,
    subdomain: string,
  ): Promise<boolean> {
    const certificate = await this.wildcardCertificates.getByScope(
      clusterId,
      subdomain,
    );
    return certificate?.status === CertificateStatus.VALID;
  }
}
