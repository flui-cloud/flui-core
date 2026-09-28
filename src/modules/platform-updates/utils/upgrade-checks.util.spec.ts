import {
  API_CHECK,
  apiImageCheck,
  deploymentChecks,
  failingChecksMessage,
  nodesCheck,
  sameImage,
  systemNamespaces,
} from './upgrade-checks.util';

describe('the checks that close an update', () => {
  it('treats an image the same whatever registry host names it', () => {
    expect(
      sameImage('ghcr.io/flui-cloud/core:2.0.0', 'flui-cloud/core:2.0.0'),
    ).toBe(true);
    expect(
      sameImage('ghcr.io/flui-cloud/core:2.0.0', 'flui-cloud/core:1.0.0'),
    ).toBe(false);
  });

  it('reads only kube-system on a workload cluster', () => {
    expect(systemNamespaces(false)).toEqual(['kube-system']);
    expect(systemNamespaces(true)[0]).toBe('kube-system');
  });

  it('fails the nodes check on a node that is not Ready, or one not at the target', () => {
    const nodes = [
      {
        name: 'n1',
        role: 'server' as const,
        kubeletVersion: 'v1',
        ready: false,
      },
    ];
    expect(nodesCheck('c', { nodes, upToDate: true }, 'v2')).toMatchObject({
      ok: false,
      detail: 'not Ready: n1',
    });
    expect(nodesCheck('c', { nodes: [], upToDate: false }, 'v2').detail).toBe(
      'not all on v2',
    );
    expect(nodesCheck('c', { nodes: [], upToDate: false }, null).ok).toBe(true);
  });

  it('checks Traefik apart from the other system components', () => {
    const [traefik, others] = deploymentChecks('c', [
      { namespace: 'kube-system', name: 'traefik', available: true },
      { namespace: 'flui-system', name: 'flui-web', available: false },
    ]);
    expect(traefik.ok).toBe(true);
    expect(others).toMatchObject({
      ok: false,
      detail: 'not available: flui-system/flui-web',
    });
    expect(deploymentChecks('c', [])[0].detail).toBe('not found');
  });

  it('says what the API runs when it is not the target', () => {
    const ref = { namespace: 'flui-system', name: 'flui-api' };
    expect(apiImageCheck(ref, null, 'core:2')).toMatchObject({
      name: API_CHECK,
      ok: false,
      detail: 'flui-system/flui-api not found',
    });
    expect(
      apiImageCheck(ref, { images: ['core:1'], available: true }, 'core:2')
        .detail,
    ).toBe('runs core:1');
    expect(
      apiImageCheck(ref, { images: ['core:2'], available: true }, 'core:2').ok,
    ).toBe(true);
  });

  it('lists what failed in one sentence', () => {
    expect(
      failingChecksMessage([
        { name: 'A', ok: false, detail: 'x' },
        { name: 'B', ok: false },
      ]),
    ).toBe('Checks that did not pass: A (x); B.');
  });
});
