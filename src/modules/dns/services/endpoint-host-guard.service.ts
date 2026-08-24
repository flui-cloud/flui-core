import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { SandboxTenantEntity } from '../../sandbox/entities/sandbox-tenant.entity';
import { ClusterDnsZoneEntity } from '../entities/cluster-dns-zone.entity';
import {
  hostsOverlap,
  isDirectChildOf,
  normalizeHost,
} from '../utils/host-claim.util';
import { isInsideTenancySubdomain } from '../utils/tenancy-subdomain.util';
import { TenancySubdomainService } from './tenancy-subdomain.service';
import { SandboxSubdomainService } from './sandbox-subdomain.service';

export const HOST_NOT_OWNED_CODE = 'endpoint_host_not_yours';
export const HOST_ALREADY_SERVED_CODE = 'endpoint_host_already_served';

/** One host declared somewhere on the cluster, and by whom. */
interface ServedHost {
  host: string;
  namespace: string;
  by: string;
}

/**
 * May this caller point that hostname at that application?
 *
 * Nothing used to ask. `GatewayService.addRoute` passed the requested host
 * straight through, and the only check on the way was that it looked like an
 * FQDN — so a sandbox guest could publish its application on a domain nobody on
 * the instance owns, and, worse, on a name another namespace was already
 * serving. Two Ingresses declaring one host is not a race, it is whoever
 * Traefik happens to pick answering for the other.
 *
 * Two rules, and they are different questions:
 *
 *   - a **sandbox tenancy** may only name hosts inside the subdomain its own
 *     cluster serves applications from. A trial is not a place to bring a
 *     domain, and the wildcard certificate that fronts the tenancy reaches
 *     exactly one label deep;
 *   - **everybody**, guest or owner, is refused a name another namespace on the
 *     cluster already declares. The cluster is the authority on that, not our
 *     table: the instance's own API, dashboard and identity provider are served
 *     by objects that were never endpoints of ours, and they are precisely the
 *     names worth stealing.
 */
@Injectable()
export class EndpointHostGuardService {
  private readonly logger = new Logger(EndpointHostGuardService.name);

  /** The group Traefik has used since 3.0; the older one is `traefik.containo.us`. */
  private static readonly INGRESS_ROUTE_API = 'traefik.io/v1alpha1';

  constructor(
    @InjectRepository(SandboxTenantEntity)
    private readonly sandboxTenants: Repository<SandboxTenantEntity>,
    @InjectRepository(ClusterDnsZoneEntity)
    private readonly clusterDnsZones: Repository<ClusterDnsZoneEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly tenancySubdomains: TenancySubdomainService,
    private readonly sandboxSubdomains: SandboxSubdomainService,
  ) {}

  /**
   * Throws unless `fqdn` may be claimed for an application living in
   * `namespace` on `cluster`. Asked only when the caller supplied the host:
   * a name Flui derives from a slug is already inside the cluster's own
   * subdomain and unique there by construction.
   */
  async assertClaimable(
    cluster: ClusterEntity,
    namespace: string,
    fqdn: string,
  ): Promise<void> {
    const host = normalizeHost(fqdn);
    await this.assertInsideTenancySubdomain(cluster, namespace, host);
    await this.assertNotServedElsewhere(cluster, namespace, host);
  }

  /**
   * The space a tenancy may name inside.
   *
   * Two answers, and which one applies is decided by a certificate rather than
   * by a setting. A tenancy that has `*.<tenancy>.<cluster>.<zone>` issued and
   * valid owns exactly that, and nothing wider: the shared
   * `<cluster>.<zone>` stops being available to it the moment it has somewhere
   * of its own. A tenancy without that certificate — every tenancy today, and
   * every new one for the first minutes of its life — falls back to
   * `<cluster>.<zone>`, which is the only place it can actually be served.
   *
   * The fallback is never *wider* than what a tenancy has today, so this can
   * only ever refuse more than it used to.
   */
  private async assertInsideTenancySubdomain(
    cluster: ClusterEntity,
    namespace: string,
    host: string,
  ): Promise<void> {
    const isSandbox = await this.sandboxTenants.exists({
      where: { clusterId: cluster.id, namespace },
    });
    if (!isSandbox) return;

    // Both answers to the same question, and in practice only ever one of them:
    // the shared subdomain is the decided shape, the per-tenancy one is
    // excluded by decision and off. A tenancy that has either owns exactly
    // that and no longer the shared `<cluster>.<zone>`.
    const own = [
      ...(await this.sandboxSubdomains.activeSubdomains(cluster, namespace)),
      ...(await this.tenancySubdomains.activeSubdomains(cluster, namespace)),
    ];
    if (own.length > 0) {
      // `isInsideTenancySubdomain` refuses a wildcard itself, so the
      // claims-everything case below is already covered here.
      if (own.some((suffix) => isInsideTenancySubdomain(host, suffix))) return;
      throw this.notOwned(own, host);
    }

    const suffixes = await this.appSubdomains(cluster);
    // A wildcard is one label under the subdomain, so the check below would let
    // it through — and `*.<cluster>.<zone>` is every name the instance has not
    // taken yet, which is the opposite of a tenancy's own space. Named here
    // rather than left to the collision check, which only refuses what is
    // already served and would happily hand over an empty cluster.
    const claimsEverything = host.startsWith('*.');
    if (
      !claimsEverything &&
      suffixes.some((suffix) => isDirectChildOf(host, suffix))
    ) {
      return;
    }

    throw this.notOwned(suffixes, host);
  }

  private notOwned(suffixes: string[], host: string): ForbiddenException {
    return new ForbiddenException({
      statusCode: 403,
      code: HOST_NOT_OWNED_CODE,
      message:
        suffixes.length > 0
          ? `A sandbox tenancy can only publish one name at a time under ${suffixes
              .map((s) => `*.${s}`)
              .join(' or ')}.`
          : 'A sandbox tenancy cannot publish on a hostname of its own choosing.',
      fqdn: host,
    });
  }

  private async appSubdomains(cluster: ClusterEntity): Promise<string[]> {
    const zones = await this.clusterDnsZones.find({
      where: { clusterId: cluster.id },
      relations: ['dnsZone'],
    });
    return zones
      .map((zone) => zone.dnsZone?.zoneName)
      .filter((name): name is string => !!name)
      .map((name) => normalizeHost(`${cluster.name}.${name}`));
  }

  private async assertNotServedElsewhere(
    cluster: ClusterEntity,
    namespace: string,
    host: string,
  ): Promise<void> {
    const served = await this.servedHosts(cluster);
    const clash = served.find(
      (s) => s.namespace !== namespace && hostsOverlap(s.host, host),
    );
    if (!clash) return;

    throw new ConflictException({
      statusCode: 409,
      code: HOST_ALREADY_SERVED_CODE,
      message: `Host ${host} is already served by ${clash.by} elsewhere on this cluster.`,
      fqdn: host,
    });
  }

  /**
   * Every host the cluster answers for, with the namespace that declared it.
   *
   * Read from the cluster and not from `app_endpoints`, because the table only
   * knows the hosts Flui created endpoints for: the instance's own API,
   * dashboard and identity provider are Traefik IngressRoutes, and to that
   * table they do not exist.
   *
   * A cluster we cannot read refuses the claim. Answering "nothing is served
   * here" when the truth is "we did not manage to look" is the one answer this
   * method must never give.
   */
  private async servedHosts(cluster: ClusterEntity): Promise<ServedHost[]> {
    const kubeconfig = this.kubeconfigFor(cluster);
    const [ingresses, ingressRoutes] = await Promise.all([
      this.list(kubeconfig, cluster, 'Ingress'),
      this.list(
        kubeconfig,
        cluster,
        'IngressRoute',
        EndpointHostGuardService.INGRESS_ROUTE_API,
      ),
    ]);

    const hosts: ServedHost[] = [];
    for (const item of ingresses) {
      const ns = item?.metadata?.namespace ?? '';
      for (const rule of item?.spec?.rules ?? []) {
        if (rule?.host) {
          hosts.push({
            host: normalizeHost(rule.host),
            namespace: ns,
            by: `Ingress ${ns}/${item?.metadata?.name}`,
          });
        }
      }
    }
    for (const item of ingressRoutes) {
      const ns = item?.metadata?.namespace ?? '';
      for (const route of item?.spec?.routes ?? []) {
        for (const host of hostsInMatch(route?.match)) {
          hosts.push({
            host,
            namespace: ns,
            by: `IngressRoute ${ns}/${item?.metadata?.name}`,
          });
        }
      }
    }
    return hosts;
  }

  private async list(
    kubeconfig: string,
    cluster: ClusterEntity,
    kind: string,
    apiVersion?: string,
  ): Promise<Record<string, any>[]> {
    try {
      return await this.kubernetesService.listCrdResources(
        kubeconfig,
        kind,
        undefined,
        apiVersion,
      );
    } catch (error) {
      this.logger.warn(
        `Could not list ${kind} on cluster ${cluster.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ConflictException({
        statusCode: 409,
        code: HOST_ALREADY_SERVED_CODE,
        message: `Cannot check what cluster ${cluster.id} already serves, so the hostname cannot be claimed right now.`,
      });
    }
  }

  private kubeconfigFor(cluster: ClusterEntity): string {
    if (!cluster.kubeconfigEncrypted) {
      throw new ConflictException({
        statusCode: 409,
        code: HOST_ALREADY_SERVED_CODE,
        message: `Cluster ${cluster.id} has no kubeconfig, so what it already serves cannot be checked.`,
      });
    }
    return this.kubernetesService.patchKubeconfigServer(
      this.encryptionService.decrypt(cluster.kubeconfigEncrypted),
    );
  }
}

/** The hosts named by a Traefik rule expression: ``Host(`a`, `b`) || Host(`c`)``. */
export function hostsInMatch(match: unknown): string[] {
  if (typeof match !== 'string') return [];
  const hosts: string[] = [];
  const calls = match.matchAll(/Host\(([^)]*)\)/gi);
  for (const call of calls) {
    for (const quoted of call[1].matchAll(/[`'"]([^`'"]+)[`'"]/g)) {
      hosts.push(normalizeHost(quoted[1]));
    }
  }
  return hosts;
}
