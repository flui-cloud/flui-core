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
const DEFERRED_RETRY_WAIT_MS = 5_000;
export const LIVE_CHECK_MIN_INTERVAL_MS = 30_000;
const LIVE_CHECK_MEMO_MAX_ENTRIES = 5_000;

@Injectable()
export class CertificateStatusRefreshService {
  private readonly logger = new Logger(CertificateStatusRefreshService.name);
  private readonly lastLiveCheck = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();

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
  refreshIfNeeded(
    endpointId: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const running = this.inFlight.get(endpointId);
    if (running) return running;
    const last = this.lastLiveCheck.get(endpointId);
    if (
      !opts.force &&
      last !== undefined &&
      Date.now() - last < LIVE_CHECK_MIN_INTERVAL_MS
    ) {
      return Promise.resolve();
    }
    const refresh = this.refresh(endpointId).finally(() => {
      this.inFlight.delete(endpointId);
    });
    this.inFlight.set(endpointId, refresh);
    return refresh;
  }

  private noteLiveCheck(endpointId: string): void {
    this.lastLiveCheck.delete(endpointId);
    if (this.lastLiveCheck.size >= LIVE_CHECK_MEMO_MAX_ENTRIES) {
      const oldest = this.lastLiveCheck.keys().next().value as string;
      this.lastLiveCheck.delete(oldest);
    }
    this.lastLiveCheck.set(endpointId, Date.now());
  }

  private async refresh(endpointId: string): Promise<void> {
    const endpoint = await this.appEndpointService.getEndpoint(endpointId);
    const worthDoubting =
      endpoint.certificateRequired &&
      !endpoint.certificateDeferredSince &&
      (endpoint.certificateStatus === CertificateStatus.ISSUING ||
        endpoint.certificateStatus === CertificateStatus.FAILED ||
        endpoint.certificateStatus === null);
    if (!worthDoubting) return;

    this.noteLiveCheck(endpointId);
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

  /**
   * Every endpoint still recorded as issuing, and every one whose certificate
   * waits for its name to be published: that wait is retried here, briefly,
   * so it ends on its own instead of when somebody presses Sync.
   */
  async sweep(): Promise<number> {
    const pending = await this.appEndpointService.listByCertificateStatus(
      CertificateStatus.ISSUING,
    );
    for (const endpoint of pending) {
      await this.refreshIfNeeded(endpoint.id, { force: true });
    }
    const deferred = await this.appEndpointService.listCertificateDeferred();
    for (const endpoint of deferred) {
      try {
        await this.reconciliation.reconcile(endpoint.id, {
          dnsWaitMs: DEFERRED_RETRY_WAIT_MS,
        });
      } catch (err) {
        this.logger.warn(
          `Retry of deferred certificate for ${endpoint.id} failed: ${(err as Error).message}`,
        );
      }
    }
    return pending.length + deferred.length;
  }
}
