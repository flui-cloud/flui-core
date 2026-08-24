import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { SandboxTenantEntity } from '../../sandbox/entities/sandbox-tenant.entity';
import { ClusterDnsZoneEntity } from '../entities/cluster-dns-zone.entity';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';
import { WildcardCertificateService } from './wildcard-certificate.service';
import { buildTenancySubdomain } from '../utils/tenancy-subdomain.util';

/**
 * Whether a tenancy has a subdomain of its own yet, and how to get it one.
 *
 * The rule the whole thing turns on: **a tenancy is only named after itself
 * once the certificate that covers that name is valid.** Until then it keeps
 * publishing under the shared `<cluster>.<zone>`, which the cluster's existing
 * wildcard already answers for.
 *
 * That is not caution for its own sake. Issuing `*.<tenancy>.<cluster>.<zone>`
 * is an ACME order with a DNS-01 challenge: minutes on a good day, and it can
 * fail. Moving the name first and waiting for the certificate afterwards means
 * every new tenancy spends those minutes handing its visitor an `https://` link
 * that a browser refuses — the demo's first screen, showing a security warning.
 * Moving the name only after means the worst case is the name it has today.
 *
 * Off by default. A cluster that has never issued a tenancy certificate must
 * behave exactly as it does now.
 *
 * ---
 *
 * **Do not turn `FLUI_SANDBOX_TENANCY_SUBDOMAIN` on. It is off by decision, not
 * awaiting a decision.**
 *
 * One certificate per tenancy makes the number of ACME orders a function of how
 * many guests pass through the installation, and an ACME account has a weekly
 * ceiling. With hundreds of demo guests that ceiling is reached and *nobody*
 * gets a certificate — including the instance itself. The rule that replaced
 * this shape: the number of certificates issued must be a constant of the
 * installation, never a function of its traffic.
 *
 * What is used instead is `SandboxSubdomainService` — one subdomain,
 * `<label>.<zone>`, one certificate, one DNS record, for every tenancy at once.
 *
 * This code is kept and not deleted because the machine underneath it,
 * `WildcardCertificateService.resolveScope`, is shared with that path and its
 * tests are what prove the scope arithmetic. Nothing here runs while the flag
 * is off.
 */
@Injectable()
export class TenancySubdomainService {
  private static readonly ENV_KEY = 'FLUI_SANDBOX_TENANCY_SUBDOMAIN';
  private readonly logger = new Logger(TenancySubdomainService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(SandboxTenantEntity)
    private readonly sandboxTenants: Repository<SandboxTenantEntity>,
    @InjectRepository(ClusterDnsZoneEntity)
    private readonly clusterDnsZones: Repository<ClusterDnsZoneEntity>,
    private readonly wildcardCertificates: WildcardCertificateService,
  ) {}

  isEnabled(): boolean {
    const raw = this.configService.get<string | boolean | undefined>(
      TenancySubdomainService.ENV_KEY,
    );
    if (raw === undefined || raw === null) return false;
    if (typeof raw === 'boolean') return raw;
    return String(raw).trim().toLowerCase() === 'true';
  }

  /**
   * The name this tenancy would publish under in the given zone, whether or not
   * a certificate for it exists yet. Null when the feature is off, when the
   * namespace is not a sandbox tenancy, or when the parts do not make a
   * hostname.
   */
  async nominalSubdomain(
    cluster: ClusterEntity,
    namespace: string,
    zoneName: string,
  ): Promise<string | null> {
    if (!this.isEnabled()) return null;
    if (!(await this.isTenancy(cluster.id, namespace))) return null;
    return buildTenancySubdomain({
      namespace,
      clusterName: cluster.name,
      zoneName,
    });
  }

  /**
   * The name this tenancy publishes under *today* — the same string, but only
   * once `*.<subdomain>` is a valid certificate on this cluster. Null means
   * "keep the shared name", which is the answer for every tenancy until its
   * certificate lands and the answer forever if it never does.
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
   * Every subdomain this tenancy currently publishes under, across the zones
   * the cluster serves — the space a hostname claim has to fall inside.
   *
   * Empty when no tenancy certificate is valid yet, and the caller then falls
   * back to the cluster-wide subdomain: the tenancy's space really is the wider
   * one until its own certificate exists, and pretending otherwise would refuse
   * a guest the only name it can actually be served on.
   */
  async activeSubdomains(
    cluster: ClusterEntity,
    namespace: string,
  ): Promise<string[]> {
    if (!this.isEnabled()) return [];
    if (!(await this.isTenancy(cluster.id, namespace))) return [];

    const zones = await this.clusterDnsZones.find({
      where: { clusterId: cluster.id },
      relations: ['dnsZone'],
    });

    const active: string[] = [];
    for (const zone of zones) {
      const zoneName = zone.dnsZone?.zoneName;
      if (!zoneName) continue;
      const subdomain = buildTenancySubdomain({
        namespace,
        clusterName: cluster.name,
        zoneName,
      });
      if (!subdomain) continue;
      if (await this.certificateIsValid(cluster.id, subdomain)) {
        active.push(subdomain);
      }
    }
    return active;
  }

  /**
   * Ask for `*.<tenancy>.<cluster>.<zone>`, reusing the machine that already
   * issues every other wildcard on the cluster rather than a second one beside
   * it. Meant to be called while a tenancy is being built, so the order runs
   * against the wait for its seed rather than against a visitor.
   *
   * **Never throws.** A tenancy without its certificate is a tenancy on the
   * shared name, which is exactly where it started; a tenancy that failed to
   * provision because ACME was slow is a tenancy nobody gets.
   *
   * **Decided once.** Nothing re-reads a certificate that arrives after this
   * returns, so a slow order does not later promote the tenancy: it keeps the
   * shared name for its whole life. Deliberate — the alternative is a tenancy
   * whose first applications are on one hostname and its later ones on another,
   * which is harder to explain to the person using it than one name that works.
   */
  async ensureCertificate(
    cluster: ClusterEntity,
    namespace: string,
  ): Promise<{ subdomain: string; ready: boolean } | null> {
    if (!this.isEnabled()) return null;

    const zones = await this.clusterDnsZones.find({
      where: { clusterId: cluster.id },
      relations: ['dnsZone'],
    });
    const zoneName = zones
      .map((zone) => zone.dnsZone?.zoneName)
      .filter((name): name is string => !!name)
      // Deterministic across restarts and across API instances: a tenancy that
      // gets a different zone on a retry gets a second certificate and keeps
      // neither name.
      .sort((a, b) => a.localeCompare(b))[0];
    if (!zoneName) return null;

    const subdomain = buildTenancySubdomain({
      namespace,
      clusterName: cluster.name,
      zoneName,
    });
    if (!subdomain) {
      this.logger.warn(
        `[tenancy-subdomain] namespace "${namespace}" on cluster ${cluster.id} does not reduce to a hostname — keeping the shared name`,
      );
      return null;
    }

    try {
      const result = await this.wildcardCertificates.ensureForScope(
        cluster.id,
        subdomain,
        namespace,
      );
      if (!result) {
        this.logger.log(
          `[tenancy-subdomain] no wildcard available for *.${subdomain} — keeping the shared name`,
        );
        return null;
      }
      this.logger.log(
        `[tenancy-subdomain] *.${subdomain} ${result.ready ? 'is valid' : 'is still issuing'}`,
      );
      return { subdomain, ready: result.ready };
    } catch (err) {
      this.logger.warn(
        `[tenancy-subdomain] could not issue *.${subdomain}: ${
          err instanceof Error ? err.message : String(err)
        } — keeping the shared name`,
      );
      return null;
    }
  }

  /**
   * Take the tenancy's certificate away when the tenancy goes. The master
   * Secret lives in `flui-system`, so deleting the namespace does not: without
   * this every reaped tenancy leaves a certificate behind, and a renewal for a
   * name nothing serves is an ACME order spent on nothing.
   *
   * Never throws, for the same reason the reaper's other steps do not.
   */
  async releaseCertificates(
    cluster: ClusterEntity,
    namespace: string,
  ): Promise<number> {
    const zones = await this.clusterDnsZones.find({
      where: { clusterId: cluster.id },
      relations: ['dnsZone'],
    });

    let removed = 0;
    for (const zone of zones) {
      const zoneName = zone.dnsZone?.zoneName;
      if (!zoneName) continue;
      const subdomain = buildTenancySubdomain({
        namespace,
        clusterName: cluster.name,
        zoneName,
      });
      if (!subdomain) continue;
      try {
        if (
          await this.wildcardCertificates.deleteForScope(cluster.id, subdomain)
        ) {
          removed += 1;
        }
      } catch (err) {
        this.logger.warn(
          `[tenancy-subdomain] could not remove *.${subdomain}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return removed;
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
