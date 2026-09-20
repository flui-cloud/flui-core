import { Injectable, Logger } from '@nestjs/common';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';
import { AppEndpointService } from './app-endpoint.service';
import { AppEndpointReconciliationService } from './app-endpoint-reconciliation.service';
import { ClusterDnsGateway } from '../gateway/cluster-dns.gateway';

/**
 * Bringing a certificate's recorded state up to date with the cluster's.
 *
 * `issuing` is written when the order is placed and by nothing afterwards:
 * cert-manager marks its Certificate Ready and tells nobody here. Until this
 * existed the only things that looked were the dashboard's endpoint screens —
 * and an application's URL is withheld while the certificate is still coming,
 * so an app whose certificate went valid still had no link anywhere.
 *
 * The sweep only ever looks at endpoints recorded as `issuing`, a small set
 * that drains itself.
 */
@Injectable()
export class CertificateStatusRefreshService {
  private readonly logger = new Logger(CertificateStatusRefreshService.name);

  constructor(
    private readonly appEndpointService: AppEndpointService,
    private readonly reconciliation: AppEndpointReconciliationService,
    private readonly clusterDnsGateway: ClusterDnsGateway,
  ) {}

  /**
   * Ask the cluster and write down the answer, when the recorded one is worth
   * doubting: `issuing` is in flight, `failed` may have recovered on a retry,
   * and a null was never established at all. `valid` and `expired` are left
   * alone — neither changes without something else writing them.
   */
  async refreshIfNeeded(endpointId: string): Promise<void> {
    const endpoint = await this.appEndpointService.getEndpoint(endpointId);
    const worthDoubting =
      endpoint.certificateRequired &&
      (endpoint.certificateStatus === CertificateStatus.ISSUING ||
        endpoint.certificateStatus === CertificateStatus.FAILED ||
        endpoint.certificateStatus === null);
    if (!worthDoubting) return;

    try {
      const { status, message } =
        await this.reconciliation.getCertificateStatus(endpointId);
      if (status === null) return;
      if (
        status === endpoint.certificateStatus &&
        message === endpoint.certificateMessage
      ) {
        return;
      }
      await this.appEndpointService.updateCertificateStatus(
        endpointId,
        status,
        message,
      );
      this.clusterDnsGateway.emitEndpointCertStatus(endpoint.clusterId, {
        clusterId: endpoint.clusterId,
        endpointId: endpoint.id,
        fqdn: endpoint.fqdn,
        certificateStatus: status,
        certificateMessage: message,
        tlsEnabled:
          !!endpoint.certificateRequired && status === CertificateStatus.VALID,
        timestamp: new Date(),
      });
    } catch (err) {
      // A cluster that cannot be reached is not a reason to fail the read this
      // is attached to, nor to stop the sweep partway through the others.
      this.logger.warn(
        `Live cert status refresh failed for ${endpointId}: ${(err as Error).message}`,
      );
    }
  }

  /** Every endpoint still recorded as issuing, wherever it lives. */
  async sweep(): Promise<number> {
    const pending = await this.appEndpointService.listByCertificateStatus(
      CertificateStatus.ISSUING,
    );
    for (const endpoint of pending) {
      await this.refreshIfNeeded(endpoint.id);
    }
    return pending.length;
  }
}
