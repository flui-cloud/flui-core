// Pulled in transitively and ship ESM that jest won't parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import {
  CertificateStatusRefreshService,
  LIVE_CHECK_MIN_INTERVAL_MS,
} from './certificate-status-refresh.service';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';

type Endpoint = {
  id: string;
  clusterId: string;
  fqdn: string;
  certificateRequired: boolean;
  certificateStatus: CertificateStatus | null;
  certificateMessage: string | null;
  certificateDeferredSince?: Date | null;
};

const anEndpoint = (over: Partial<Endpoint> = {}): Endpoint => ({
  id: 'ep1',
  clusterId: 'c1',
  fqdn: 'app.example.test',
  certificateRequired: true,
  certificateStatus: CertificateStatus.ISSUING,
  certificateMessage: null,
  ...over,
});

const build = (
  endpoints: Endpoint[],
  live: { status: CertificateStatus | null; message: string | null },
) => {
  const updates: Array<[string, CertificateStatus, string | null]> = [];
  const emitted: unknown[] = [];
  const reconcile = jest.fn(async () => true);
  const service = new CertificateStatusRefreshService(
    {
      getEndpoint: jest.fn(async (id: string) =>
        endpoints.find((e) => e.id === id),
      ),
      listByCertificateStatus: jest.fn(async (s: CertificateStatus) =>
        endpoints.filter((e) => e.certificateStatus === s),
      ),
      listCertificateDeferred: jest.fn(async () =>
        endpoints.filter((e) => e.certificateDeferredSince),
      ),
      updateCertificateStatus: jest.fn(
        async (
          id: string,
          status: CertificateStatus,
          message: string | null,
        ) => {
          updates.push([id, status, message]);
        },
      ),
    } as never,
    { getCertificateStatus: jest.fn(async () => live), reconcile } as never,
    { emitEndpointCertStatus: jest.fn((_c, p) => emitted.push(p)) } as never,
  );
  return { service, updates, emitted, reconcile };
};

describe('keeping a certificate status current', () => {
  /**
   * The failure this exists for, measured on a live install: cert-manager
   * marked the Certificate Ready and told nobody, the row stayed `issuing`,
   * and because an application's URL is withheld for exactly that window, the
   * app had no link anywhere — for as long as nobody opened the endpoint
   * screens, which were the only thing that ever looked.
   */
  it('writes down the state the cluster actually reports', async () => {
    const { service, updates, emitted } = build([anEndpoint()], {
      status: CertificateStatus.VALID,
      message: 'issued',
    });
    await service.refreshIfNeeded('ep1');
    expect(updates).toEqual([['ep1', CertificateStatus.VALID, 'issued']]);
    expect(emitted).toHaveLength(1);
  });

  it('sweeps every endpoint still recorded as issuing', async () => {
    const { service, updates } = build(
      [anEndpoint(), anEndpoint({ id: 'ep2' })],
      { status: CertificateStatus.VALID, message: null },
    );
    expect(await service.sweep()).toBe(2);
    expect(updates.map(([id]) => id)).toEqual(['ep1', 'ep2']);
  });

  it('retries a certificate waiting for its name to be published, briefly', async () => {
    const { service, reconcile } = build(
      [
        anEndpoint({
          id: 'ep3',
          certificateStatus: CertificateStatus.PENDING,
          certificateDeferredSince: new Date(),
        }),
      ],
      { status: CertificateStatus.VALID, message: null },
    );
    expect(await service.sweep()).toBe(1);
    expect(reconcile).toHaveBeenCalledWith('ep3', { dnsWaitMs: 5_000 });
  });

  /**
   * `valid` and `expired` are left alone: neither changes without something
   * else writing it, so asking the cluster about them is a call that can only
   * ever confirm what is already recorded.
   */
  it.each([CertificateStatus.VALID, CertificateStatus.EXPIRED])(
    'does not go asking about %s',
    async (certificateStatus) => {
      const { service, updates } = build([anEndpoint({ certificateStatus })], {
        status: CertificateStatus.VALID,
        message: null,
      });
      await service.refreshIfNeeded('ep1');
      expect(updates).toEqual([]);
    },
  );

  it('leaves an endpoint that was never asked for TLS alone', async () => {
    const { service, updates } = build(
      [anEndpoint({ certificateRequired: false })],
      { status: CertificateStatus.VALID, message: null },
    );
    await service.refreshIfNeeded('ep1');
    expect(updates).toEqual([]);
  });

  it('writes nothing when the cluster reports what is already recorded', async () => {
    const { service, updates, emitted } = build([anEndpoint()], {
      status: CertificateStatus.ISSUING,
      message: null,
    });
    await service.refreshIfNeeded('ep1');
    expect(updates).toEqual([]);
    expect(emitted).toEqual([]);
  });

  /**
   * One unreachable cluster must not stop the others, and must not fail the
   * read this is attached to on the controller path.
   */
  it('survives a cluster it cannot reach', async () => {
    const endpoints = [anEndpoint()];
    const service = new CertificateStatusRefreshService(
      {
        getEndpoint: jest.fn(async () => endpoints[0]),
        listByCertificateStatus: jest.fn(async () => endpoints),
        listCertificateDeferred: jest.fn(async () => []),
        updateCertificateStatus: jest.fn(),
      } as never,
      {
        getCertificateStatus: jest.fn(async () => {
          throw new Error('cluster unreachable');
        }),
      } as never,
      { emitEndpointCertStatus: jest.fn() } as never,
    );
    await expect(service.sweep()).resolves.toBe(1);
  });
});

describe('throttling the live certificate check', () => {
  const live = { status: CertificateStatus.ISSUING, message: null };

  afterEach(() => jest.useRealTimers());

  const withCounter = () => {
    const getCertificateStatus = jest.fn(async () => live);
    const service = new CertificateStatusRefreshService(
      {
        getEndpoint: jest.fn(async () => anEndpoint()),
        listByCertificateStatus: jest.fn(async () => [anEndpoint()]),
        listCertificateDeferred: jest.fn(async () => []),
        updateCertificateStatus: jest.fn(),
      } as never,
      { getCertificateStatus } as never,
      { emitEndpointCertStatus: jest.fn() } as never,
    );
    return { service, getCertificateStatus };
  };

  it('asks the cluster at most once every 30 seconds per endpoint', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { service, getCertificateStatus } = withCounter();
    await service.refreshIfNeeded('ep1');
    jest.setSystemTime(1_000_000 + LIVE_CHECK_MIN_INTERVAL_MS - 1);
    await service.refreshIfNeeded('ep1');
    expect(getCertificateStatus).toHaveBeenCalledTimes(1);
    jest.setSystemTime(1_000_000 + LIVE_CHECK_MIN_INTERVAL_MS);
    await service.refreshIfNeeded('ep1');
    expect(getCertificateStatus).toHaveBeenCalledTimes(2);
  });

  it('shares one check between concurrent reads of the same endpoint', async () => {
    const { service, getCertificateStatus } = withCounter();
    const first = service.refreshIfNeeded('ep1');
    const second = service.refreshIfNeeded('ep1');
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(getCertificateStatus).toHaveBeenCalledTimes(1);
  });

  it('lets the background sweep look even right after a read did', async () => {
    const { service, getCertificateStatus } = withCounter();
    await service.refreshIfNeeded('ep1');
    await service.sweep();
    expect(getCertificateStatus).toHaveBeenCalledTimes(2);
  });
});
