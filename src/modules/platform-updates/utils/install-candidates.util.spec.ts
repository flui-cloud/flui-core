import {
  CONTROL_REMOTE_WRITE_URL,
  candidateRefList,
  candidateValues,
  parseWebConfig,
  remoteWriteOf,
  routeHostsOf,
} from './install-candidates.util';
import { RELEASE } from '../../../config/release.config';

const cluster = {
  id: 'c-1',
  name: 'control',
  provider: 'hetzner',
  masterIpAddress: '1.2.3.4',
  masterPrivateIp: '10.0.0.2',
  nipHostnameToken: null,
  bootstrapRef: 'ref-cluster',
  nodes: [{ id: 's-1', nodeType: 'master' }],
} as never;

describe('where install values may come from', () => {
  it('orders the refs a master may come from, without repeats', () => {
    expect(
      candidateRefList(
        { bootstrapRef: 'ref-record' } as never,
        { bootstrapRef: 'ref-cluster' } as never,
        ['ref-cluster', 'ref-published'],
      ),
    ).toEqual([
      'ref-record',
      'ref-cluster',
      RELEASE.bootstrapRef,
      'ref-published',
    ]);
  });

  it('reads the hosts of IngressRoutes and the agent push target', () => {
    expect(
      routeHostsOf([
        { spec: { routes: [{ match: 'Host(`api.x.io`) || Host(`x.io`)' }] } },
      ]),
    ).toEqual(['api.x.io', 'x.io']);
    expect(
      remoteWriteOf({
        spec: {
          template: {
            spec: { containers: [{ args: ['-remoteWrite.url=http://a/w'] }] },
          },
        },
      }),
    ).toBe('http://a/w');
    expect(remoteWriteOf(null)).toBeNull();
  });

  it('takes a web config that does not parse as empty', () => {
    expect(parseWebConfig('{"a":1}')).toEqual({ a: 1 });
    expect(parseWebConfig('{')).toEqual({});
    expect(parseWebConfig(undefined)).toEqual({});
  });

  it('offers what Flui knows, and never a secret variable', () => {
    const candidates = candidateValues({
      cluster,
      kind: 'control',
      env: {},
      apiConfig: { API_BASE_URL: 'https://api.example.com/v1' },
      webConfig: { certificateMode: 'staging' },
      routeHosts: ['api.routed.io'],
      remoteWrites: ['ignored-on-control'],
      running: { FLUI_API_IMAGE_TAG: '2.0.0' },
      secretVariables: new Set(['OIDC_ISSUER']),
    });
    expect(candidates.CLUSTER_ID).toEqual(['c-1']);
    expect(candidates.REMOTE_WRITE_URL).toEqual([CONTROL_REMOTE_WRITE_URL]);
    expect(candidates.FLUI_BASE_DOMAIN).toEqual([
      'example.com',
      'routed.io',
      '1-2-3-4.nip.io',
    ]);
    expect(candidates.CERTIFICATE_MODE[0]).toBe('staging');
    expect(candidates.FLUI_API_IMAGE_TAG[0]).toBe('2.0.0');
    expect(candidates.OIDC_ISSUER).toBeUndefined();
  });
});
