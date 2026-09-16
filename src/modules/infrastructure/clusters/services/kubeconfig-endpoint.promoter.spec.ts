import { KubeconfigEndpointPromoter } from './kubeconfig-endpoint.promoter';

const kubeconfig = (host: string) =>
  [
    'apiVersion: v1',
    'clusters:',
    '- cluster:',
    '    certificate-authority-data: LS0tLUNBLS0tLQ==',
    `    server: https://${host}:6443`,
    '  name: default',
  ].join('\n');

describe('KubeconfigEndpointPromoter', () => {
  const build = (
    cluster: any,
    overlay: any,
    answers = true,
  ): {
    promoter: KubeconfigEndpointPromoter;
    save: jest.Mock;
    enrolSan: jest.Mock;
  } => {
    const save = jest.fn();
    const enrolSan = jest
      .fn()
      .mockResolvedValue({ outcome: 'already-present' });
    const promoter = new KubeconfigEndpointPromoter(
      { find: jest.fn().mockResolvedValue([cluster]), save } as any,
      {
        decrypt: (v: string) => v.replace(/^enc:/, ''),
        encrypt: (v: string) => `enc:${v}`,
      } as any,
      { nodeOverlayFor: jest.fn().mockResolvedValue(overlay) } as any,
      { enrolOverlayAddress: enrolSan } as any,
    );
    (promoter as unknown as { answers: () => Promise<boolean> }).answers =
      async () => answers;
    return { promoter, save, enrolSan };
  };

  const workload = (host: string) => ({
    id: 'c1',
    name: 'wl',
    kubeconfigEncrypted: `enc:${kubeconfig(host)}`,
    nodes: [{ id: 'n1', nodeType: 'master' }],
  });

  beforeEach(() => {
    process.env.FLUI_WG_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.FLUI_WG_ENABLED;
  });

  it('moves the server line onto the overlay once the tunnel answers', async () => {
    const { promoter, save } = build(workload('91.99.53.190'), {
      nodeAddress: '10.250.0.4',
      enrolled: true,
    });

    expect(await promoter.promoteAll()).toBe(1);
    expect(save.mock.calls[0][0].kubeconfigEncrypted).toContain(
      'server: https://10.250.0.4:6443',
    );
  });

  it('leaves the address alone while the tunnel stays silent', async () => {
    // Writing an address nothing answers on makes the cluster unmanageable with
    // no error anywhere, which is worse than the public address it replaces.
    const { promoter, save } = build(
      workload('91.99.53.190'),
      { nodeAddress: '10.250.0.4', enrolled: true },
      false,
    );

    expect(await promoter.promoteAll()).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('waits for a peer that has actually handshaken', async () => {
    const { promoter, save } = build(workload('91.99.53.190'), {
      nodeAddress: '10.250.0.4',
      enrolled: false,
    });

    expect(await promoter.promoteAll()).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('never moves back, even when the peer goes stale', async () => {
    // Health says when the tunnel has earned the traffic, never when to take it
    // back: the handshake goes stale after three minutes while the sweep samples
    // every ten, so one missed rekey would otherwise rewrite the address.
    const { promoter, save } = build(workload('10.250.0.4'), {
      nodeAddress: '10.250.0.4',
      enrolled: false,
    });

    expect(await promoter.promoteAll()).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('puts the address in the certificate before trying to use it', async () => {
    // The probe verifies the certificate, so a cluster whose certificate omits
    // the address could never be promoted — and nothing else runs the enrolment
    // on a loop. Seen live: a workload sat unreachable at both addresses until
    // the enrolment was triggered by hand.
    const { promoter, enrolSan } = build(workload('91.99.53.190'), {
      nodeAddress: '10.250.0.4',
      enrolled: true,
    });

    await promoter.promoteAll();

    expect(enrolSan).toHaveBeenCalledWith('c1');
  });

  it('asks for nothing once the cluster has already moved', async () => {
    const { promoter, enrolSan } = build(workload('10.250.0.4'), {
      nodeAddress: '10.250.0.4',
      enrolled: true,
    });

    await promoter.promoteAll();

    expect(enrolSan).not.toHaveBeenCalled();
  });

  it('still tries the probe when the enrolment fails', async () => {
    // An unreachable node must not stop a certificate that is already correct
    // from being used.
    const { promoter, save, enrolSan } = build(workload('91.99.53.190'), {
      nodeAddress: '10.250.0.4',
      enrolled: true,
    });
    enrolSan.mockRejectedValue(new Error('ssh timeout'));

    expect(await promoter.promoteAll()).toBe(1);
    expect(save).toHaveBeenCalled();
  });

  it('refuses to move without a CA to verify the tunnel against', async () => {
    // Promoting on an unverified probe could park a cluster on an address whose
    // certificate does not name it — a permanent TLS failure, silently.
    const cluster = workload('91.99.53.190');
    cluster.kubeconfigEncrypted = `enc:${kubeconfig('91.99.53.190').replace(/\s*certificate-authority-data:.*\n/, '\n')}`;
    const { promoter, save } = build(cluster, {
      nodeAddress: '10.250.0.4',
      enrolled: true,
    });

    expect(await promoter.promoteAll()).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('does nothing at all while the overlay is switched off', async () => {
    delete process.env.FLUI_WG_ENABLED;
    const { promoter, save } = build(workload('91.99.53.190'), {
      nodeAddress: '10.250.0.4',
      enrolled: true,
    });

    expect(await promoter.promoteAll()).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps the port the kubeconfig already names', async () => {
    const cluster = workload('91.99.53.190');
    cluster.kubeconfigEncrypted = `enc:${kubeconfig('91.99.53.190').replace(':6443', ':16443')}`;
    const { promoter, save } = build(cluster, {
      nodeAddress: '10.250.0.4',
      enrolled: true,
    });

    await promoter.promoteAll();

    expect(save.mock.calls[0][0].kubeconfigEncrypted).toContain(
      'server: https://10.250.0.4:16443',
    );
  });
});
