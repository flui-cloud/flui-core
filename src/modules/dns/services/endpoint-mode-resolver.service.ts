import { BadRequestException, Injectable } from '@nestjs/common';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ClusterDnsZoneEntity } from '../entities/cluster-dns-zone.entity';
import { CertChallenge } from '../enums/cert-challenge.enum';
import { HostnameMode } from '../enums/hostname-mode.enum';
import { buildAppNipHostname } from '../utils/nip-hostname.util';
import { buildTenancyFqdn } from '../utils/tenancy-subdomain.util';

export interface ResolveEndpointModeInput {
  cluster: ClusterEntity;
  clusterDnsZone?: ClusterDnsZoneEntity | null;
  wildcardEnabled?: boolean;
  requestedFqdn?: string;
  requestedCertChallenge?: CertChallenge;
  requestedHostnameMode?: HostnameMode;
  slug: string;
  /**
   * `<tenancy>.<cluster>.<zone>` when the namespace this endpoint belongs to
   * has a subdomain of its own *and a valid certificate for it*. Absent means
   * the shared `<cluster>.<zone>`, which is where every application lives
   * today — see `TenancySubdomainService` for why the certificate comes first.
   */
  tenancySubdomain?: string | null;
}

export interface ResolvedEndpointMode {
  certChallenge: CertChallenge;
  hostnameMode: HostnameMode;
  fqdn: string;
}

@Injectable()
export class EndpointModeResolverService {
  resolve(input: ResolveEndpointModeInput): ResolvedEndpointMode {
    const {
      cluster,
      clusterDnsZone,
      wildcardEnabled,
      requestedFqdn,
      requestedCertChallenge,
      requestedHostnameMode,
      slug,
    } = input;

    const hostnameMode =
      requestedHostnameMode ??
      (clusterDnsZone
        ? HostnameMode.DOMAIN
        : (cluster.endpointHostnameMode ?? HostnameMode.IP));

    let certChallenge: CertChallenge;
    if (hostnameMode === HostnameMode.IP) {
      if (
        requestedCertChallenge &&
        requestedCertChallenge !== CertChallenge.HTTP_01
      ) {
        throw new BadRequestException(
          'IP-based endpoints (nip.io) only support HTTP-01 challenge',
        );
      }
      certChallenge = CertChallenge.HTTP_01;
    } else {
      certChallenge =
        requestedCertChallenge ??
        (wildcardEnabled && clusterDnsZone
          ? CertChallenge.DNS_01
          : CertChallenge.HTTP_01);
      if (certChallenge === CertChallenge.DNS_01 && !clusterDnsZone) {
        throw new BadRequestException(
          'DNS-01 challenge requires a cluster DNS zone',
        );
      }
    }

    if (
      hostnameMode === HostnameMode.DOMAIN &&
      !clusterDnsZone &&
      !requestedFqdn
    ) {
      throw new BadRequestException(
        'DOMAIN hostname mode requires either a cluster DNS zone or an explicit fqdn',
      );
    }

    const fqdn =
      requestedFqdn ??
      this.generateFqdn(
        hostnameMode,
        slug,
        cluster,
        clusterDnsZone,
        input.tenancySubdomain,
      );

    return { certChallenge, hostnameMode, fqdn };
  }

  generateFqdn(
    mode: HostnameMode,
    slug: string,
    cluster: ClusterEntity,
    clusterDnsZone?: ClusterDnsZoneEntity | null,
    tenancySubdomain?: string | null,
  ): string {
    if (mode === HostnameMode.IP) {
      const ip = cluster.masterIpAddress;
      if (!ip) {
        throw new BadRequestException(
          `Cluster ${cluster.id} has no master IP yet — cannot derive nip.io hostname`,
        );
      }
      return buildAppNipHostname(slug, ip);
    }
    if (clusterDnsZone?.dnsZone) {
      // Only when the tenancy really has that name: `buildTenancyFqdn` refuses
      // anything its wildcard would not cover — a dotted slug, a hostname past
      // the length a resolver accepts — and the shared name is then still a
      // working answer, where a name outside the certificate is not.
      const own = tenancySubdomain
        ? buildTenancyFqdn(slug, tenancySubdomain)
        : null;
      return (
        own ?? `${slug}.${cluster.name}.${clusterDnsZone.dnsZone.zoneName}`
      );
    }
    return `${slug}.${cluster.name}`;
  }
}
