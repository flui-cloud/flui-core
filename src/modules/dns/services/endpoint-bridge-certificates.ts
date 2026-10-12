import { Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { AcmeCertificateService } from '../../providers/services/acme-certificate.service';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import { describeError } from '../../shared/utils/error.util';
import { AppEndpointEntity } from '../entities/app-endpoint.entity';
import { CertChallenge } from '../enums/cert-challenge.enum';
import { BridgeHost } from '../interfaces/migration-bridge.interface';
import {
  certificateProblem,
  dns01IssuerServes,
  isWildcardCertificate,
  perHostSecretName,
  renderBridgeCertificateSecret,
} from '../utils/endpoint-bridge.core';
import {
  AcmeOrder,
  CertManagerCertificate,
  CertManagerRequest,
  certificateIssuance,
  certificateRefusalNote,
  certificateRequestFailed,
  latestOwned,
} from '../utils/endpoint-bridge-issuance.core';
import { WildcardCertificateService } from './wildcard-certificate.service';
import { ClusterDnsZoneService } from './cluster-dns-zone.service';

export interface EndpointBridgeCertificateTiming {
  pollMs: number;
  issuerWaitMs: number;
}

/** What the wait needs to fall back on the source's certificate. */
export interface BridgeCertificateSource {
  bridgeId: string;
  kubeSource: string;
  endpoints: AppEndpointEntity[];
}

export const MAX_CERTIFICATE_RESETS = 2;

/**
 * The certificate side of the bridge, owned by EndpointBridgeService: places
 * a valid certificate for each bridged name on the destination.
 */
export class EndpointBridgeCertificates {
  private readonly logger = new Logger('EndpointBridgeService');

  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly acme: AcmeCertificateService,
    private readonly wildcard: WildcardCertificateService,
    private readonly zones: ClusterDnsZoneService,
    private readonly zoneServedOn: (
      endpoint: AppEndpointEntity,
      clusterId: string,
    ) => Promise<boolean>,
    private readonly timing: () => EndpointBridgeCertificateTiming,
  ) {}

  async prepare(
    bridgeId: string,
    endpoint: AppEndpointEntity,
    host: BridgeHost,
    kubeSource: string,
    kubeTarget: string,
    targetClusterId: string,
  ): Promise<BridgeHost> {
    if (this.boundToWildcardThere(endpoint)) {
      const bound = await this.wildcard
        .ensureForEndpoint(
          targetClusterId,
          endpoint.fqdn,
          endpoint.k8sNamespace,
        )
        .catch(() => null);
      if (bound) {
        return {
          ...host,
          certificate: 'wildcard',
          secretName: bound.tlsSecretName,
        };
      }
    }

    const secretName = perHostSecretName(endpoint.fqdn);
    if (!(await this.secretProblem(kubeTarget, { ...host, secretName }))) {
      return {
        ...host,
        certificate: 'present',
        secretName,
        certificateReady: true,
      };
    }

    let issuerName = await this.dns01IssuerFor(kubeTarget, endpoint);
    if (!issuerName && (await this.zoneServedOn(endpoint, targetClusterId))) {
      issuerName = await this.bringUpDns01Issuer(
        kubeTarget,
        endpoint,
        targetClusterId,
      );
    }
    if (issuerName) {
      await this.kubernetes.applyManifest(
        kubeTarget,
        this.acme.generateCertificateManifest({
          name: secretName,
          namespace: endpoint.k8sNamespace,
          secretName,
          issuerName,
          domains: [endpoint.fqdn],
        }),
      );
      return { ...host, certificate: 'dns-01', secretName };
    }

    await this.copySourceSecret(
      bridgeId,
      endpoint,
      kubeSource,
      kubeTarget,
      secretName,
    );
    return { ...host, certificate: 'copied', secretName };
  }

  async waitFor(
    hosts: BridgeHost[],
    kubeconfig: string,
    waitMs: number,
    source?: BridgeCertificateSource,
  ): Promise<void> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      for (const host of hosts) {
        if (host.certificateReady || !host.secretName) continue;
        const problem = await this.secretProblem(kubeconfig, host);
        host.certificateReady = !problem;
        host.certificateMessage = problem;
        if (problem && host.certificate === 'dns-01') {
          await this.recoverRefused(host, kubeconfig, source).catch(
            (err: unknown) =>
              this.logger.warn(
                `[bridge] certificate for ${host.fqdn} not recovered: ${describeError(err)}`,
              ),
          );
        }
      }
      const waiting = hosts.some((h) => h.secretName && !h.certificateReady);
      if (!waiting || Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, this.timing().pollMs));
    }
  }

  async secretProblem(
    kubeconfig: string,
    host: Pick<BridgeHost, 'fqdn' | 'namespace' | 'secretName'>,
  ): Promise<string | null> {
    if (!host.secretName)
      return `no secret holds a certificate for ${host.fqdn}`;
    const secret = await this.kubernetes
      .getResource(kubeconfig, 'Secret', host.secretName, host.namespace)
      .catch(() => null);
    const crt: string | undefined = secret?.data?.['tls.crt'];
    if (!crt) {
      return `secret ${host.namespace}/${host.secretName} holds no certificate yet`;
    }
    return certificateProblem(
      Buffer.from(crt, 'base64').toString('utf8'),
      host.fqdn,
      new Date(),
    );
  }

  /**
   * A refused issuance otherwise waits out cert-manager's backoff (an hour at
   * first): reset it twice, then serve the source's certificate. The
   * Certificate stays: cert-manager writes the secret only once it issues, so
   * the copy holds until the destination has its own.
   */
  private async recoverRefused(
    host: BridgeHost,
    kubeconfig: string,
    source?: BridgeCertificateSource,
  ): Promise<void> {
    const name = host.secretName!;
    const certificate: CertManagerCertificate | null = await this.kubernetes
      .getResource(kubeconfig, 'Certificate', name, host.namespace)
      .catch(() => null);
    if (!certificate) return;
    const request = latestOwned<CertManagerRequest>(
      await this.kubernetes.listCrdResources(
        kubeconfig,
        'CertificateRequest',
        host.namespace,
      ),
      'Certificate',
      name,
    );
    const order = request?.metadata?.name
      ? latestOwned<AcmeOrder>(
          await this.kubernetes.listCrdResources(
            kubeconfig,
            'Order',
            host.namespace,
          ),
          'CertificateRequest',
          request.metadata.name,
        )
      : null;
    const issuance = certificateIssuance(certificate, request, order);
    if (issuance.state !== 'failed') return;
    const retry = host.certificateRetry ?? { resets: 0, failedAt: null };
    if (!isNewFailure(issuance.failedAt, retry)) return;

    if (retry.resets < MAX_CERTIFICATE_RESETS) {
      if (request?.metadata?.name && certificateRequestFailed(request)) {
        await this.kubernetes.deleteResource(
          kubeconfig,
          'CertificateRequest',
          request.metadata.name,
          host.namespace,
        );
      }
      const operations = (
        ['lastFailureTime', 'failedIssuanceAttempts'] as const
      )
        .filter((field) => certificate.status?.[field] !== undefined)
        .map((field) => ({ op: 'remove', path: `/status/${field}` }));
      if (operations.length) {
        await this.kubernetes.jsonPatchObjectStatus(
          kubeconfig,
          {
            apiVersion: 'cert-manager.io/v1',
            plural: 'certificates',
            name,
            namespace: host.namespace,
          },
          operations,
        );
      }
      host.certificateRetry = {
        resets: retry.resets + 1,
        failedAt: issuance.failedAt,
      };
      host.certificateNote = certificateRefusalNote(
        host.fqdn,
        issuance.reason,
        {
          kind: 'retried',
        },
      );
      this.logger.warn(`[bridge] ${host.certificateNote}`);
      return;
    }

    host.certificateRetry = { ...retry, failedAt: issuance.failedAt };
    const endpoint = source?.endpoints.find((e) =>
      host.endpointIds.includes(e.id),
    );
    try {
      if (!source || !endpoint) {
        throw new Error('the source cluster was not given to copy from');
      }
      await this.copySourceSecret(
        source.bridgeId,
        endpoint,
        source.kubeSource,
        kubeconfig,
        name,
        '',
      );
    } catch (err) {
      host.certificateNote = certificateRefusalNote(
        host.fqdn,
        issuance.reason,
        {
          kind: 'stuck',
          why: `the source's certificate cannot be used: ${describeError(err).replace(/\.$/, '')}`,
          retryAt: issuance.retryAt,
        },
      );
      this.logger.warn(`[bridge] ${host.certificateNote}`);
      return;
    }
    host.certificate = 'copied';
    host.certificateNote = certificateRefusalNote(host.fqdn, issuance.reason, {
      kind: 'copied',
    });
    host.certificateMessage = await this.secretProblem(kubeconfig, host);
    host.certificateReady = !host.certificateMessage;
    this.logger.warn(`[bridge] ${host.certificateNote}`);
  }

  /** Mirrors the wildcard binding the endpoint reconciler will make on the destination. */
  private boundToWildcardThere(endpoint: AppEndpointEntity): boolean {
    return (
      this.wildcard.isEnabled() &&
      !endpoint.sanCertificateId &&
      endpoint.certChallenge !== CertChallenge.HTTP_01
    );
  }

  /** The destination's DNS-01 ClusterIssuer, when it is Ready and has a solver for the name. */
  private async dns01IssuerFor(
    kubeconfig: string,
    endpoint: AppEndpointEntity,
  ): Promise<string | null> {
    const provider =
      endpoint.certificateProvider ??
      endpoint.clusterDnsZone?.certificateProvider ??
      CertificateProvider.LETS_ENCRYPT;
    const name = this.acme.getWildcardIssuerName(
      this.acme.getAcmeServerUrl(provider),
    );
    const issuer = await this.kubernetes
      .getResource(kubeconfig, 'ClusterIssuer', name, '')
      .catch(() => null);
    return dns01IssuerServes(issuer, endpoint.fqdn) ? name : null;
  }

  /**
   * The zone is assigned to the destination but its DNS-01 issuer is missing
   * or not Ready: apply it through the same path as the cluster's DNS setup
   * and wait a bounded time, so a copy of the source key stays the last resort.
   */
  private async bringUpDns01Issuer(
    kubeconfig: string,
    endpoint: AppEndpointEntity,
    clusterId: string,
  ): Promise<string | null> {
    try {
      const acmeEmail = await this.zones.resolveAcmeEmail(clusterId);
      if (!acmeEmail) return null;
      await this.zones.applyDnsSecret(clusterId);
      await this.zones.applyDnsIssuersOnly(clusterId, { acmeEmail });
    } catch (err) {
      this.logger.warn(
        `[bridge] DNS-01 issuer could not be set up on ${clusterId}: ${describeError(err)}`,
      );
      return null;
    }
    const deadline = Date.now() + this.timing().issuerWaitMs;
    for (;;) {
      const name = await this.dns01IssuerFor(kubeconfig, endpoint);
      if (name || Date.now() >= deadline) return name;
      await new Promise((r) => setTimeout(r, this.timing().pollMs));
    }
  }

  private async copySourceSecret(
    bridgeId: string,
    endpoint: AppEndpointEntity,
    kubeSource: string,
    kubeTarget: string,
    secretName: string,
    instead = ', and the destination cannot issue one through DNS-01',
  ): Promise<void> {
    const ingress = await this.kubernetes
      .getResource(
        kubeSource,
        'Ingress',
        `${endpoint.k8sServiceName}-${endpoint.id.split('-')[0]}-ingress`,
        endpoint.k8sNamespace,
      )
      .catch(() => null);
    const sourceName: string =
      ingress?.spec?.tls?.[0]?.secretName ??
      endpoint.tlsSecretName ??
      secretName;
    const secret = await this.kubernetes
      .getResource(kubeSource, 'Secret', sourceName, endpoint.k8sNamespace)
      .catch(() => null);
    const crt: string | undefined = secret?.data?.['tls.crt'];
    const key: string | undefined = secret?.data?.['tls.key'];
    const problem = crt
      ? certificateProblem(
          Buffer.from(crt, 'base64').toString('utf8'),
          endpoint.fqdn,
          new Date(),
        )
      : null;
    if (
      crt &&
      isWildcardCertificate(Buffer.from(crt, 'base64').toString('utf8'))
    ) {
      throw new Error(
        `The source serves ${endpoint.fqdn} with a wildcard certificate, which is never copied to another cluster${instead}.`,
      );
    }
    if (!crt || !key || problem) {
      throw new Error(
        `The source has no valid certificate for ${endpoint.fqdn} to copy${
          problem ? ` (${problem})` : ''
        }${instead}.`,
      );
    }
    await this.kubernetes.applyManifest(
      kubeTarget,
      JSON.stringify(
        renderBridgeCertificateSecret({
          bridgeId,
          secretName,
          namespace: endpoint.k8sNamespace,
          crt,
          key,
        }),
      ),
    );
  }
}

/** A failure not yet acted on: after a reset the old Issuing=False condition lingers until cert-manager tries again. */
function isNewFailure(
  failedAt: string | null,
  retry: { resets: number; failedAt: string | null },
): boolean {
  if (retry.resets === 0 && retry.failedAt === null) return true;
  if (!failedAt || !retry.failedAt) return false;
  return Date.parse(failedAt) - Date.parse(retry.failedAt) > 1000;
}
