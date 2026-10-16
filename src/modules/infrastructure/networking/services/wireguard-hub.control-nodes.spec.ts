import { WireGuardHubService } from './wireguard-hub.service';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import {
  APPLIED_MARKER,
  KEY_MARKER,
  PRIVATE_KEY_MARKER,
  READY_MARKER,
  UNSUPPORTED_MARKER,
} from '../wireguard-host';
import { JUMP_UNCHANGED_MARKER } from '../jump-host';
import { WireGuardPeerRole } from '../entities/wireguard-peer.entity';
import { controlEndProblem, controlEndWarning } from '../control-end-health';
import * as endpointName from '../control-endpoint-name';

const KEY_MASTER = 'h0FoHrdl/fI6kj27RRzbjxQQEqb1Iibt/b3oYbknZtE=';
const KEY_WORKER = '+8PaqoF8+RnCIQLKaVflCPpr7escUSccTYpZLkW2JN0=';
const KEY_PRIVATE = 'hNBBm3jY4mCMeymQ4EaLuT3SEJPUrblbgnwJAJhK8Fo=';
const KEY_MEMBER = 'AvBhnd7fb29eBhWasocwevAQqcGRZI73vxFfmQuQQHk=';

const controlCluster = (extra: any[] = []) => ({
  id: 'ctl',
  provider: 'hetzner',
  masterIpAddress: '1.1.1.1',
  metadata: {},
  nodes: [
    { id: 'master', ipAddress: '1.1.1.1', metadata: {}, nodeType: 'master' },
    { id: 'worker-1', ipAddress: '2.2.2.2', metadata: {}, nodeType: 'worker' },
    ...extra,
  ],
});

/** Postgres advisory locks as they behave: a second holder waits. */
function advisoryLocks() {
  const held = new Map<string, Promise<void>>();
  const releases = new Map<string, () => void>();
  return {
    createQueryRunner: () => ({
      connect: async () => undefined,
      release: async () => undefined,
      query: async (sql: string, [a, b]: number[]) => {
        const key = `${a}:${b}`;
        if (sql.includes('pg_advisory_unlock')) {
          const release = releases.get(key);
          releases.delete(key);
          held.delete(key);
          release?.();
          return [];
        }
        while (held.has(key)) await held.get(key);
        held.set(key, new Promise((r) => releases.set(key, r)));
        return [];
      },
    }),
  } as any;
}

const dump = (key: string, handshake: number) =>
  `priv\tpub\t51821\toff\n${key}\t(none)\t9.9.9.9:4000\t10.250.0.3/32\t${handshake}\t1\t2\t0\n`;

function build(
  options: {
    cluster?: any;
    sealed?: string | null;
    workerKeyOutput?: string;
    masterApplyFails?: boolean;
    dataSource?: any;
  } = {},
) {
  const cluster = options.cluster ?? controlCluster();
  const now = Math.floor(Date.now() / 1000);
  const apply = jest.fn(async (target: any, script: string, marker: string) => {
    if (marker === READY_MARKER) {
      if (target.host === '1.1.1.1') {
        return `${KEY_MARKER}=${KEY_MASTER}\n${script.includes(PRIVATE_KEY_MARKER) ? `${PRIVATE_KEY_MARKER}=${KEY_PRIVATE}\n` : ''}${READY_MARKER}`;
      }
      return (
        options.workerKeyOutput ??
        `${KEY_MARKER}=${KEY_WORKER}\n${READY_MARKER}`
      );
    }
    if (options.masterApplyFails && target.host === '1.1.1.1') {
      throw new Error('ssh timeout');
    }
    return APPLIED_MARKER;
  });
  const run = jest.fn(async (target: any, script: string) => {
    if (script.startsWith('wg show')) {
      return target.host === '1.1.1.1'
        ? dump(KEY_MEMBER, now)
        : dump(KEY_MEMBER, now - 3600);
    }
    return JUMP_UNCHANGED_MARKER;
  });
  const rows: Record<string, any> = {
    master: {
      id: 'row-master',
      nodeId: 'master',
      isPrimary: true,
      managementIp: '10.250.0.1',
    },
    'worker-1': {
      id: 'row-worker',
      nodeId: 'worker-1',
      isPrimary: false,
      managementIp: '10.250.0.2',
    },
  };
  const peers = {
    sealedControlKey: jest.fn().mockResolvedValue(options.sealed ?? null),
    sealControlKey: jest.fn(),
    ensureControlPeer: jest.fn(
      async (p: any) =>
        (rows[p.nodeId] ??= {
          id: `row-${p.nodeId}`,
          nodeId: p.nodeId,
          isPrimary: !!p.primary,
          managementIp: '10.250.0.9',
        }),
    ),
    revokeDepartedControlPeers: jest.fn().mockResolvedValue([]),
    renderControlConfig: jest.fn(
      async (nodeId?: string) => `[Interface]\n# ${nodeId}\n`,
    ),
    markHandshake: jest.fn().mockResolvedValue(null),
    recordControlReadings: jest.fn(),
    markControlEnd: jest.fn(),
    livePeers: jest.fn().mockResolvedValue([]),
    controlPeers: jest.fn().mockResolvedValue([rows.master, rows['worker-1']]),
    revokeMember: jest.fn(),
  };
  const svc = new WireGuardHubService(
    {
      findOne: jest.fn().mockResolvedValue(cluster),
      find: jest.fn().mockResolvedValue([cluster]),
    } as any,
    peers as any,
    { apply, run } as any,
    new ManagementAddressResolver(),
    { ensureFluiNetwork: jest.fn() } as any,
    {
      encrypt: (v: string) => `sealed:${v}`,
      decrypt: (v: string) => v.replace(/^sealed:/, ''),
    } as any,
    options.dataSource ?? advisoryLocks(),
  );
  return { svc, apply, run, peers };
}

const hostsOf = (mock: jest.Mock, predicate: (call: any[]) => boolean) =>
  mock.mock.calls.filter(predicate).map((c) => c[0].host);

describe('the hub on every control node', () => {
  it('enrols and applies an end on the master and on every control worker', async () => {
    const { svc, apply, peers } = build();

    const state = await svc.ensureControlEnd();

    expect(peers.ensureControlPeer).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'master',
        primary: true,
        endpointHost: '1.1.1.1',
        publicKey: KEY_MASTER,
      }),
    );
    expect(peers.ensureControlPeer).toHaveBeenCalledWith({
      clusterId: 'ctl',
      nodeId: 'worker-1',
      publicKey: KEY_WORKER,
      endpointHost: '2.2.2.2',
    });
    expect(hostsOf(apply, (c) => c[2] === APPLIED_MARKER)).toEqual([
      '1.1.1.1',
      '2.2.2.2',
    ]);
    expect(peers.renderControlConfig).toHaveBeenCalledWith('master');
    expect(peers.renderControlConfig).toHaveBeenCalledWith('worker-1');
    expect(state?.applied).toBe(true);
    expect(state?.nodes.map((n) => [n.nodeId, n.primary, n.applied])).toEqual([
      ['master', true, true],
      ['worker-1', false, true],
    ]);
  });

  it('captures and seals the master’s key only, never a worker’s', async () => {
    const { svc, apply, peers } = build();

    await svc.ensureControlEnd();

    const keyScripts = apply.mock.calls.filter((c) => c[2] === READY_MARKER);
    expect(keyScripts.map((c) => c[0].host)).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(keyScripts[0][1]).toContain(`echo ${PRIVATE_KEY_MARKER}`);
    expect(keyScripts[1][1]).not.toContain(PRIVATE_KEY_MARKER);
    expect(peers.sealControlKey).toHaveBeenCalledTimes(1);
    expect(peers.sealControlKey).toHaveBeenCalledWith(`sealed:${KEY_PRIVATE}`);
  });

  it('restores the kept key on the master only', async () => {
    const { svc, apply } = build({ sealed: `sealed:${KEY_PRIVATE}` });

    await svc.ensureControlEnd();

    const keyScripts = apply.mock.calls.filter((c) => c[2] === READY_MARKER);
    expect(keyScripts[0][1]).toContain(KEY_PRIVATE);
    expect(keyScripts[1][1]).not.toContain(KEY_PRIVATE);
  });

  it('sets the jump user up on the master only', async () => {
    const { svc, run } = build();

    await svc.ensureControlEnd();

    expect(hostsOf(run, (c) => !String(c[1]).startsWith('wg show'))).toEqual([
      '1.1.1.1',
    ]);
  });

  it('lets the master decide a member’s status and keeps every node’s reading', async () => {
    const { svc, peers } = build();

    const state = await svc.ensureControlEnd();

    expect(peers.markHandshake).toHaveBeenCalledTimes(1);
    expect(peers.recordControlReadings).toHaveBeenCalledWith('row-master', [
      expect.objectContaining({ publicKey: KEY_MEMBER, fresh: true }),
    ]);
    expect(peers.recordControlReadings).toHaveBeenCalledWith('row-worker', [
      expect.objectContaining({ publicKey: KEY_MEMBER, fresh: false }),
    ]);
    expect(state?.nodes.map((n) => [n.fresh, n.stale])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(peers.markControlEnd).toHaveBeenCalledWith('row-master', true);
    expect(peers.markControlEnd).toHaveBeenCalledWith('row-worker', true);
  });

  it('withdraws the rows of every node no longer in the control cluster', async () => {
    const { svc, peers } = build();

    await svc.ensureControlEnd();

    expect(peers.revokeDepartedControlPeers).toHaveBeenCalledWith('ctl', [
      'master',
      'worker-1',
    ]);
  });

  it('reports a worker that cannot run WireGuard and still brings the master up', async () => {
    const { svc, apply, peers } = build({
      workerKeyOutput: `${UNSUPPORTED_MARKER}\nreason: no package`,
    });

    const state = await svc.ensureControlEnd();

    expect(hostsOf(apply, (c) => c[2] === APPLIED_MARKER)).toEqual(['1.1.1.1']);
    expect(state?.applied).toBe(false);
    expect(state?.nodes[1]).toMatchObject({
      nodeId: 'worker-1',
      applied: false,
      error: 'cannot run WireGuard',
    });
    expect(peers.markControlEnd).not.toHaveBeenCalledWith(
      'row-worker',
      expect.anything(),
    );
    expect(controlEndProblem()).toBeNull();
  });

  it('holds members back only when the master’s end fails', async () => {
    const { svc } = build({ masterApplyFails: true });

    const state = await svc.ensureControlEnd();

    expect(state?.nodes[0]).toMatchObject({ primary: true, applied: false });
    expect(controlEndProblem()?.message).toContain('the control master');
    expect(controlEndProblem()?.message).not.toContain('2.2.2.2');

    await build().svc.ensureControlEnd();
    expect(controlEndProblem()).toBeNull();
  });

  it('leaves out a control node being deleted or that failed to join, and takes the newest live master', async () => {
    const cluster = controlCluster([
      {
        id: 'worker-2',
        ipAddress: '3.3.3.3',
        metadata: {},
        nodeType: 'worker',
        status: 'deleting',
      },
      {
        id: 'worker-3',
        ipAddress: '4.4.4.4',
        metadata: {},
        nodeType: 'worker',
        status: 'error',
      },
      {
        id: 'old-master',
        ipAddress: '5.5.5.5',
        metadata: {},
        nodeType: 'master',
        createdAt: new Date(0),
      },
    ]);
    cluster.nodes[0].createdAt = new Date(1000);
    const { svc, apply, peers } = build({ cluster });

    await svc.ensureControlEnd();

    expect(peers.ensureControlPeer).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'master', primary: true }),
    );
    const touched = apply.mock.calls.map((c) => c[0].host);
    expect(touched).not.toContain('3.3.3.3');
    expect(touched).not.toContain('4.4.4.4');
    expect(peers.revokeDepartedControlPeers).toHaveBeenCalledWith('ctl', [
      'master',
      'worker-1',
      'old-master',
    ]);
  });

  it('runs one control-end pass at a time across copies, the withdrawal included', async () => {
    const dataSource = advisoryLocks();
    const first = build({ dataSource });
    const second = build({ dataSource });
    let inside = 0;
    let most = 0;
    for (const t of [first, second]) {
      t.peers.sealedControlKey.mockImplementation(async () => {
        inside += 1;
        most = Math.max(most, inside);
        await new Promise((r) => setTimeout(r, 5));
        return null;
      });
      t.peers.revokeDepartedControlPeers.mockImplementation(async () => {
        inside -= 1;
        return [];
      });
      t.peers.controlPeers.mockImplementation(async () => {
        inside += 1;
        most = Math.max(most, inside);
        await new Promise((r) => setTimeout(r, 5));
        inside -= 1;
        return [{ id: 'row-worker', nodeId: 'worker-1', isPrimary: false }];
      });
    }

    await Promise.all([
      first.svc.ensureControlEnd(),
      second.svc.ensureControlEnd(),
      second.svc.withdrawControlNode('worker-1'),
    ]);

    expect(most).toBe(1);
    expect(second.peers.revokeMember).toHaveBeenCalledWith('worker-1');
  });

  it('warns when the declared endpoint name does not lead to the master alone', async () => {
    const check = jest
      .spyOn(endpointName, 'endpointNameProblem')
      .mockResolvedValue(
        'FLUI_WG_ENDPOINT_NAME wg.example.org resolves to 2.2.2.2',
      );
    const { svc } = build();

    await svc.ensureControlEnd();

    expect(check).toHaveBeenCalledWith('1.1.1.1');
    expect(controlEndWarning()).toContain('wg.example.org');

    check.mockResolvedValue(null);
    await svc.ensureControlEnd();
    expect(controlEndWarning()).toBeNull();
    check.mockRestore();
  });

  it('applies the hub config on every control node that has a row when no target is named', async () => {
    const { svc, apply } = build();

    expect(await svc.applyControlConfig()).toBe(true);

    expect(hostsOf(apply, (c) => c[2] === APPLIED_MARKER)).toEqual([
      '1.1.1.1',
      '2.2.2.2',
    ]);
  });

  it('withdraws a control worker before it is deleted, never the primary', async () => {
    const { svc, peers } = build();

    expect(await svc.withdrawControlNode('worker-1')).toBe(true);
    expect(peers.revokeMember).toHaveBeenCalledWith('worker-1');

    peers.revokeMember.mockClear();
    expect(await svc.withdrawControlNode('master')).toBe(false);
    expect(await svc.withdrawControlNode('not-a-control-node')).toBe(false);
    expect(peers.revokeMember).not.toHaveBeenCalled();
  });

  it('leaves control rows to the hub when their old cluster is gone', async () => {
    const revokeMember = jest.fn();
    const svc = new WireGuardHubService(
      {
        find: jest.fn().mockResolvedValue([{ id: 'ctl-new' }, { id: 'wl' }]),
      } as any,
      {
        livePeers: jest.fn().mockResolvedValue([
          {
            clusterId: 'ctl-old',
            nodeId: 'old-master',
            role: WireGuardPeerRole.CONTROL,
          },
          {
            clusterId: 'gone',
            nodeId: 'n9',
            role: WireGuardPeerRole.MEMBER,
          },
        ]),
        revokeMember,
      } as any,
      {} as any,
      new ManagementAddressResolver(),
      { ensureFluiNetwork: jest.fn() } as any,
      {} as any,
      advisoryLocks(),
    );

    expect(await svc.revokeOrphanPeers()).toBe(1);
    expect(revokeMember).toHaveBeenCalledWith('n9');
    expect(revokeMember).not.toHaveBeenCalledWith('old-master');
  });
});
