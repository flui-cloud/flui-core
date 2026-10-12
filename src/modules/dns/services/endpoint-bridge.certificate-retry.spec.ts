jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { EndpointBridgeService } from './endpoint-bridge.service';
import { HostnameMode } from '../enums/hostname-mode.enum';
import { CertChallenge } from '../enums/cert-challenge.enum';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';

const CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIB1TCCAT6gAwIBAgIJAMQyOq6yUOEcMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV',
  'BAMMEHNob3AuZXhhbXBsZS5jb20wIBcNMjYxMDExMTY0NzA2WhgPMjEyNjA5MTcx',
  'NjQ3MDZaMBsxGTAXBgNVBAMMEHNob3AuZXhhbXBsZS5jb20wgZ8wDQYJKoZIhvcN',
  'AQEBBQADgY0AMIGJAoGBAPkEtLqph5ArxYScUsl5K7b6D97Gsb5e2h9IJGqOLVV5',
  'DrlbI3VEW1lAijGVRjl2T2QptDVLE1MbIFvuBWtytEa+222YHuAHZ5ys4jcqYkxq',
  'XI6pfpuRJc0gKtuDCyH9wUP1ZmB8TH3OL/e9b5ieiVkdsc+VGsh+oFc2azvDi/Xn',
  'AgMBAAGjHzAdMBsGA1UdEQQUMBKCEHNob3AuZXhhbXBsZS5jb20wDQYJKoZIhvcN',
  'AQELBQADgYEATyrurS3NAGSYn9BgTVtnZPEQ/YNXwhGRun4bhqjCWkF/8MD0rwzW',
  'hLlxxDUL59lHN33C4pU+dhb+Kui7wqJLmgNM/osvxuLp0dMEFxQaywZrquExMlVU',
  'jyYDg0Z6x+CdM2lGIzDnx6+wLU1F2pQyapL5qVKmr0UIcTeBkoLr6Ro=',
  '-----END CERTIFICATE-----',
].join('\n');

const FINALIZE_403 =
  'Failed to finalize Order: 403 urn:ietf:params:acme:error:unauthorized: Error finalizing order :: authorizations for these identifiers not valid';
const NAME = 'tls-shop-example-com';

const tlsSecret = () => ({
  type: 'kubernetes.io/tls',
  data: {
    'tls.crt': Buffer.from(CERT).toString('base64'),
    'tls.key': Buffer.from('KEY').toString('base64'),
  },
});

const endpoint: any = {
  id: 'abcdef12-0000-0000-0000-000000000001',
  fqdn: 'shop.example.com',
  k8sNamespace: 'ns',
  k8sServiceName: 'shop-svc',
  hostnameMode: HostnameMode.DOMAIN,
  certChallenge: CertChallenge.HTTP_01,
  certificateRequired: true,
  certificateProvider: CertificateProvider.LETS_ENCRYPT,
  clusterDnsZoneId: 'za',
  clusterDnsZone: { dnsZoneId: 'dz', dnsZone: { zoneName: 'example.com' } },
  wildcardCertificateId: null,
  sanCertificateId: null,
  tlsSecretName: null,
};

const dns01Issuer = {
  status: { conditions: [{ type: 'Ready', status: 'True' }] },
  spec: {
    acme: {
      solvers: [
        { dns01: { webhook: {} }, selector: { dnsZones: ['example.com'] } },
      ],
    },
  },
};

const failedAt = (n: number) =>
  new Date(Date.parse('2026-10-12T09:00:40Z') + n * 60_000)
    .toISOString()
    .replace('.000', '');

/**
 * cert-manager on the destination: each try is refused until `issueOnTry`;
 * right after a reset the old Issuing=False condition lingers for one read.
 */
function setup(opts: { issueOnTry?: number; sourceSecret?: boolean }) {
  const calls: string[] = [];
  const objects: Record<string, any> = {};
  if (opts.sourceSecret !== false) {
    objects['kc-A:Secret/' + NAME] = tlsSecret();
  }
  let tries = 1;
  let stale = false;
  const issued = () =>
    opts.issueOnTry !== undefined && tries >= opts.issueOnTry;
  const certificate = () => {
    if (issued()) {
      return { status: { conditions: [{ type: 'Ready', status: 'True' }] } };
    }
    const issuing = {
      type: 'Issuing',
      status: 'False',
      reason: 'Failed',
      message: `The certificate request has failed to complete and will be retried: ${FINALIZE_403}`,
      lastTransitionTime: failedAt(stale ? tries - 2 : tries - 1),
    };
    if (stale) {
      stale = false;
      return { status: { conditions: [issuing] } };
    }
    return {
      status: {
        conditions: [issuing],
        lastFailureTime: failedAt(tries - 1),
        failedIssuanceAttempts: tries,
      },
    };
  };
  const request = () => ({
    metadata: {
      name: `${NAME}-${tries}`,
      annotations: { 'cert-manager.io/certificate-revision': String(tries) },
      ownerReferences: [{ kind: 'Certificate', name: NAME }],
    },
    status: {
      conditions: [
        { type: 'Ready', status: 'False', reason: 'Failed', message: 'x' },
      ],
    },
  });
  const kube = {
    patchKubeconfigServer: (k: string) => k,
    getResource: jest.fn(async (kc: string, kind: string, name: string) => {
      if (kind === 'ClusterIssuer') return dns01Issuer;
      if (kind === 'Certificate' && kc === 'kc-B') return certificate();
      if (kind === 'Secret' && kc === 'kc-B' && issued()) return tlsSecret();
      return objects[`${kc}:${kind}/${name}`] ?? null;
    }),
    listCrdResources: jest.fn(async (_kc: string, kind: string) => {
      if (issued()) return [];
      if (kind === 'CertificateRequest') return [request()];
      return [
        {
          metadata: {
            name: `${NAME}-${tries}-1`,
            ownerReferences: [
              { kind: 'CertificateRequest', name: `${NAME}-${tries}` },
            ],
          },
          status: { state: 'errored', reason: FINALIZE_403 },
        },
      ];
    }),
    deleteResource: jest.fn(async (_kc: string, kind: string, name: string) => {
      calls.push(`delete ${kind} ${name}`);
    }),
    jsonPatchObjectStatus: jest.fn(
      async (_kc: string, ref: any, ops: any[]) => {
        const paths = ops.map((o) => o.op + ' ' + o.path).join(', ');
        calls.push(`patch ${ref.plural}/${ref.name} ${paths}`);
        tries += 1;
        stale = true;
      },
    ),
    applyManifest: jest.fn(async (kc: string, text: string) => {
      const manifest = text.trim().startsWith('{')
        ? JSON.parse(text)
        : { kind: /kind: (\w+)/.exec(text)?.[1] };
      calls.push(`apply ${manifest.kind}`);
      if (manifest.kind === 'Secret') {
        objects[`${kc}:Secret/${manifest.metadata.name}`] = manifest;
      }
      return [];
    }),
    readObject: jest.fn(async () => null),
  };
  const service = new EndpointBridgeService(
    {
      findOne: jest.fn(async ({ where }: any) => ({
        id: where.id,
        kubeconfigEncrypted: `kc-${where.id}`,
      })),
    } as never,
    { findOne: jest.fn(async () => null) } as never,
    kube as never,
    { decrypt: (v: string) => v } as never,
    {
      getAcmeServerUrl: () => 'https://acme-v02.api.letsencrypt.org/directory',
      getWildcardIssuerName: () => 'letsencrypt-production-wildcard',
      generateCertificateManifest: () => `kind: Certificate\nname: ${NAME}`,
    } as never,
    { isEnabled: () => false } as never,
    {} as never,
  );
  service.certificatePollMs = 0;
  const prepare = (waitMs = 2_000) =>
    service.prepare({
      bridgeId: 'mig-1',
      endpoints: [endpoint],
      sourceClusterId: 'A',
      targetClusterId: 'B',
      waitMs,
    });
  return { service, kube, calls, prepare };
}

const RESET = [
  `delete CertificateRequest ${NAME}-1`,
  `patch certificates/${NAME} remove /status/lastFailureTime, remove /status/failedIssuanceAttempts`,
];

describe('EndpointBridgeService.prepare when the certificate authority refuses the name', () => {
  it('resets the backoff at once and waits for the reissued certificate', async () => {
    const { calls, prepare } = setup({ issueOnTry: 2 });

    const [host] = await prepare();

    expect(calls).toEqual(['apply Certificate', ...RESET]);
    expect(host).toEqual(
      expect.objectContaining({
        certificate: 'dns-01',
        certificateReady: true,
        certificateRetry: { resets: 1, failedAt: '2026-10-12T09:00:40Z' },
        certificateNote:
          "Let's Encrypt refused the certificate for shop.example.com (unauthorized: authorizations for these identifiers not valid); retried now.",
      }),
    );
  });

  it('resets at most twice, then serves the source certificate and keeps the Certificate', async () => {
    const { calls, prepare, kube } = setup({});

    const [host] = await prepare();

    expect(calls).toEqual([
      'apply Certificate',
      ...RESET,
      `delete CertificateRequest ${NAME}-2`,
      RESET[1],
      'apply Secret',
    ]);
    expect(kube.deleteResource).not.toHaveBeenCalledWith(
      'kc-B',
      'Certificate',
      NAME,
      'ns',
    );
    expect(host).toEqual(
      expect.objectContaining({
        certificate: 'copied',
        certificateReady: true,
        certificateMessage: null,
        certificateRetry: { resets: 2, failedAt: failedAt(2) },
        certificateNote:
          "Let's Encrypt refused the certificate for shop.example.com (unauthorized: authorizations for these identifiers not valid); using the source's certificate until the new cluster has its own.",
      }),
    );
  });

  it('says why when the source has no certificate to fall back on, and does not loop on it', async () => {
    const { service, calls, prepare } = setup({ sourceSecret: false });

    const [host] = await prepare(100);

    expect(calls.filter((c) => c.startsWith('patch'))).toHaveLength(2);
    expect(calls).not.toContain('apply Secret');
    expect(host.certificate).toBe('dns-01');
    expect(host.certificateReady).toBe(false);
    expect(host.certificateNote).toMatch(
      /^Let's Encrypt refused the certificate for shop\.example\.com \(unauthorized: .*\); retries did not help and the source's certificate cannot be used: The source has no valid certificate for shop\.example\.com to copy\. cert-manager tries again from 2026-10-12T13:02:40\.000Z\.$/,
    );
    await expect(service.certificatesValid([host], 'B')).resolves.toContain(
      host.certificateNote!,
    );
  });
});
