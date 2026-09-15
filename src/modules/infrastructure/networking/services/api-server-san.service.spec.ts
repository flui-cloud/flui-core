import { ApiServerSanService } from './api-server-san.service';
import {
  SAN_APPLIED_MARKER,
  SAN_PRESENT_MARKER,
  SAN_ROLLED_BACK_MARKER,
  SAN_UNSUPPORTED_MARKER,
} from '../api-server-san';

const CERT_OUT =
  'IP Address:10.250.0.9, IP Address:203.0.113.10, IP Address:10.43.0.1';

describe('ApiServerSanService', () => {
  const cluster = (over: Record<string, unknown> = {}) => ({
    id: 'c1',
    name: 'workload-1',
    provider: 'hetzner',
    status: 'ready',
    masterIpAddress: '203.0.113.10',
    metadata: {},
    nodes: [
      {
        id: 'n1',
        nodeType: 'master',
        ipAddress: '203.0.113.10',
        metadata: {},
      },
    ],
    ...over,
  });

  const build = (
    opts: {
      row?: unknown;
      overlay?: unknown;
      run?: jest.Mock;
    } = {},
  ) => {
    const run =
      opts.run ??
      jest
        .fn()
        .mockResolvedValueOnce(`${SAN_APPLIED_MARKER}\n`)
        .mockResolvedValueOnce(CERT_OUT);
    const operations = {
      create: (x: any) => x,
      save: async (x: any) => ({ id: 'op-1', ...x }),
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new ApiServerSanService(
      { findOne: jest.fn().mockResolvedValue(opts.row ?? cluster()) } as any,
      operations as any,
      queue as any,
      {
        nodeOverlayFor: jest
          .fn()
          .mockResolvedValue(
            opts.overlay === undefined
              ? { nodeAddress: '10.250.0.9', enrolled: true }
              : opts.overlay,
          ),
      } as any,
      { run } as any,
    );
    return { service, run, queue };
  };

  it('adds the address and reads back what the certificate now covers', async () => {
    const { service, run } = build();

    const result = await service.enrolOverlayAddress('c1');

    expect(result.outcome).toBe('applied');
    expect(result.address).toBe('10.250.0.9');
    expect(result.certificateIps).toContain('10.250.0.9');
    // The script carries the address it was asked for.
    expect(run.mock.calls[0][1]).toContain('10\\.250\\.0\\.9');
  });

  it('is a no-op on a cluster that already carries the address', async () => {
    const run = jest
      .fn()
      .mockResolvedValueOnce(`${SAN_PRESENT_MARKER}\n`)
      .mockResolvedValueOnce(CERT_OUT);
    const { service } = build({ run });

    expect((await service.enrolOverlayAddress('c1')).outcome).toBe(
      'already-present',
    );
  });

  it('refuses a peer that has never handshaken', async () => {
    // A row is not a tunnel. Restarting K3s on a live master to reach an
    // address that has never carried a packet risks the cluster for nothing.
    const { service, run } = build({
      overlay: { nodeAddress: '10.250.0.9', enrolled: false },
    });

    await expect(service.enrolOverlayAddress('c1')).rejects.toThrow(
      /has not handshaken/,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses when the overlay is off entirely', async () => {
    const run = jest.fn();
    const service = new ApiServerSanService(
      { findOne: jest.fn().mockResolvedValue(cluster()) } as any,
      { create: (x: any) => x, save: async (x: any) => x } as any,
      { add: jest.fn() } as any,
      { nodeOverlayFor: jest.fn().mockResolvedValue(undefined) } as any,
      { run } as any,
    );

    await expect(service.enrolOverlayAddress('c1')).rejects.toThrow(
      /overlay is off/,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a cluster that is not healthy to begin with', async () => {
    const { service, run } = build({ row: cluster({ status: 'error' }) });
    await expect(service.enrolOverlayAddress('c1')).rejects.toThrow(/is error/);
    expect(run).not.toHaveBeenCalled();
  });

  it('reports a rollback as the failure it is, naming what was restored', async () => {
    const run = jest.fn().mockResolvedValue(`${SAN_ROLLED_BACK_MARKER}\n`);
    const { service } = build({ run });

    await expect(service.enrolOverlayAddress('c1')).rejects.toThrow(
      /restored to the certificate and configuration it had/,
    );
  });

  it('says so when the node is not a K3s server at all', async () => {
    const run = jest
      .fn()
      .mockResolvedValueOnce(`${SAN_UNSUPPORTED_MARKER}\n`)
      .mockResolvedValueOnce(SAN_UNSUPPORTED_MARKER);
    const { service } = build({ run });

    const result = await service.enrolOverlayAddress('c1');
    expect(result.outcome).toBe('unsupported');
    expect(result.certificateIps).toEqual([]);
  });

  it('refuses output with no outcome at all rather than assuming success', async () => {
    const run = jest.fn().mockResolvedValue('bash: openssl: not found\n');
    const { service } = build({ run });

    await expect(service.enrolOverlayAddress('c1')).rejects.toThrow(
      /without any outcome marker/,
    );
  });

  it('refuses a cluster whose master has no SSH endpoint of its own', async () => {
    // The worker keeps the cluster's target list non-empty, so this is the
    // narrow case that matters: endpoints exist, but none is this node's.
    const { service } = build({
      row: cluster({
        nodes: [
          { id: 'n1', nodeType: 'master', ipAddress: null, metadata: {} },
          {
            id: 'n2',
            nodeType: 'worker',
            ipAddress: '203.0.113.11',
            metadata: {},
          },
        ],
      }),
    });

    await expect(service.enrolOverlayAddress('c1')).rejects.toThrow(
      /No SSH endpoint/,
    );
  });

  describe('as a tracked operation', () => {
    it('queues one and records what it is about', async () => {
      const { service, queue } = build();

      const op = await service.enrolOverlayAddressAsync('c1');

      expect(op.operationType).toBe('enrol_cluster_overlay');
      expect(op.metadata).toMatchObject({ managementAddress: '10.250.0.9' });
      expect(queue.add).toHaveBeenCalledWith(
        'enrol-cluster-overlay',
        { operationId: 'op-1', clusterId: 'c1' },
        expect.objectContaining({ attempts: 1 }),
      );
    });

    it('never retries a restart of a live master', async () => {
      const { service, queue } = build();
      await service.enrolOverlayAddressAsync('c1');
      expect(queue.add.mock.calls[0][2].attempts).toBe(1);
    });

    it('refuses before queuing anything, not after', async () => {
      // An operator asking for something that cannot work is told now, rather
      // than left watching an operation fail.
      const { service, queue } = build({
        overlay: { nodeAddress: '10.250.0.9', enrolled: false },
      });

      await expect(service.enrolOverlayAddressAsync('c1')).rejects.toThrow(
        /has not handshaken/,
      );
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
