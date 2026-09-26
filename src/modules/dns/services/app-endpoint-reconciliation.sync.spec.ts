jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { AppEndpointReconciliationService } from './app-endpoint-reconciliation.service';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';

describe('AppEndpointReconciliationService.syncEndpoint', () => {
  const endpoint = {
    id: 'ep-1',
    fqdn: 'shop.example.com',
    clusterId: 'c-1',
    k8sNamespace: 'user-a',
    certificateRequired: true,
    certificateStatus: CertificateStatus.FAILED,
    clusterDnsZone: { zoneName: 'example.com' },
    dnsRecordId: 'rec-1',
    dnsRecordValue: '203.0.113.7',
    hostnameMode: 'dns',
  };

  function build(
    live: { status: CertificateStatus | null; message: string | null },
    ran = true,
  ) {
    const kube = { deleteResource: jest.fn() };
    const endpoints = {
      getEndpoint: jest.fn().mockResolvedValue(endpoint),
      updateCertificateStatus: jest.fn(),
    };
    const service = new AppEndpointReconciliationService(
      null as never,
      kube as never,
      null as never,
      null as never,
      null as never,
      endpoints as never,
      null as never,
      null as never,
      null as never,
      null as never,
      { emitEndpointCertStatus: jest.fn() } as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    const s = service as unknown as Record<string, jest.Mock>;
    jest.spyOn(service, 'reconcile').mockResolvedValue(ran);
    jest.spyOn(service, 'getCertificateStatus').mockResolvedValue(live);
    s.getCluster = jest.fn().mockResolvedValue({ id: 'c-1' });
    s.getKubeconfig = jest.fn().mockResolvedValue('kubeconfig');
    return { service, kube, endpoints };
  }

  it('orders a failed per-host certificate again and says so', async () => {
    const { service, kube } = build({
      status: CertificateStatus.FAILED,
      message: 'rate limited',
    });
    const out = await service.syncEndpoint('ep-1');
    expect(kube.deleteResource).toHaveBeenCalledWith(
      'kubeconfig',
      'Certificate',
      'tls-shop-example-com',
      'user-a',
    );
    expect(out.certificate).toBe('retried');
    expect(out.says).toContain('Flui asked for a new one');
  });

  it('leaves a valid certificate alone and writes down that it is valid', async () => {
    const { service, kube, endpoints } = build({
      status: CertificateStatus.VALID,
      message: null,
    });
    const out = await service.syncEndpoint('ep-1');
    expect(kube.deleteResource).not.toHaveBeenCalled();
    expect(endpoints.updateCertificateStatus).toHaveBeenCalledWith(
      'ep-1',
      CertificateStatus.VALID,
      null,
    );
    expect(out.certificate).toBe('valid');
  });

  it('reports a sync already running instead of starting a second', async () => {
    const { service } = build(
      { status: CertificateStatus.VALID, message: null },
      false,
    );
    const out = await service.syncEndpoint('ep-1');
    expect(out.says).toContain('already running');
  });
});
