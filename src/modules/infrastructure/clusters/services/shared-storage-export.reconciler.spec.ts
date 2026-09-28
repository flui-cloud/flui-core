import { ServiceUnavailableException } from '@nestjs/common';
import { execFileSync } from 'child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildSharedStorageExportScript,
  SharedStorageExportReconciler,
  sharedStorageExportLine,
  sharedStorageExportNetworks,
} from './shared-storage-export.reconciler';
import { ClusterStatus } from '../entities/cluster.entity';
import { NodeType } from '../entities/cluster-node.entity';

const OPTS = 'rw,async,no_subtree_check,no_root_squash';

describe('sharedStorageExportNetworks', () => {
  it('offers the private subnets and the pod range, nothing wider', () => {
    expect(
      sharedStorageExportNetworks({
        subnetRanges: ['10.0.1.0/24', '0.0.0.0/0', '::/0', '*', 'nope'],
      }),
    ).toEqual(['10.0.1.0/24', '10.42.0.0/16']);
  });

  it('is empty when no private network is known, never a fallback to anyone', () => {
    expect(sharedStorageExportNetworks({})).toEqual([]);
    expect(
      sharedStorageExportNetworks({ subnetRanges: ['0.0.0.0/0'] }),
    ).toEqual([]);
  });

  it('adds declared node networks and private node addresses, deduplicated and ordered', () => {
    expect(
      sharedStorageExportNetworks({
        subnetRanges: ['192.168.10.0/24'],
        declaredNodeNetworks: ['10.0.0.0/24', '192.168.10.0/24'],
        nodePrivateIps: ['10.0.0.12', '8.8.8.8', '', '172.20.1.5'],
      }),
    ).toEqual([
      '10.0.0.0/24',
      '10.0.0.12/32',
      '172.20.1.5/32',
      '192.168.10.0/24',
      '10.42.0.0/16',
    ]);
  });

  it('writes the line in the shape the bootstrap writes it', () => {
    expect(sharedStorageExportLine(['10.0.1.0/24', '10.42.0.0/16'])).toBe(
      `/var/lib/flui/storage 10.0.1.0/24(${OPTS}) 10.42.0.0/16(${OPTS})`,
    );
    expect(sharedStorageExportLine([])).toBe('');
  });
});

describe('buildSharedStorageExportScript on a real shell', () => {
  const setup = (exportsContent: string | null, withShare = true) => {
    const dir = mkdtempSync(join(tmpdir(), 'flui-nfs-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const share = join(dir, 'storage');
    if (withShare) mkdirSync(share);
    const exportsFile = join(dir, 'exports');
    if (exportsContent !== null) writeFileSync(exportsFile, exportsContent);
    return { dir, bin, share, exportsFile };
  };

  const fakeExportfs = (bin: string, exportsFile: string) => {
    const path = join(bin, 'exportfs');
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        'if [ "$1" = "-ra" ]; then',
        '  echo "ra" >> "$FAKE_CALLS"',
        '  if [ "$FAKE_FAIL" = "1" ]; then echo "exportfs: bad client list" >&2; exit 1; fi',
        '  exit 0',
        'fi',
        `if [ "$1" = "-v" ]; then awk '{print $1}' '${exportsFile}'; exit 0; fi`,
        'exit 0',
      ].join('\n'),
    );
    chmodSync(path, 0o755);
    const systemctl = join(bin, 'systemctl');
    writeFileSync(systemctl, '#!/bin/sh\nexit 0\n');
    chmodSync(systemctl, 0o755);
  };

  const run = (
    ctx: ReturnType<typeof setup>,
    networks: string[],
    env: Record<string, string> = {},
  ): string =>
    execFileSync(
      '/bin/sh',
      [
        '-c',
        buildSharedStorageExportScript(networks, {
          exportsFile: ctx.exportsFile,
          sharePath: ctx.share,
        }),
      ],
      {
        env: {
          PATH: `${ctx.bin}:/usr/bin:/bin`,
          FAKE_CALLS: join(ctx.dir, 'calls'),
          ...env,
        },
      },
    ).toString();

  it('replaces an export to anyone and keeps the operator’s other lines', () => {
    const ctx = setup('');
    writeFileSync(
      ctx.exportsFile,
      `/srv/mine 192.168.1.0/24(ro)\n${ctx.share} *(${OPTS})\n`,
    );
    fakeExportfs(ctx.bin, ctx.exportsFile);

    const out = run(ctx, ['10.0.1.0/24', '10.42.0.0/16']);

    expect(out).toContain('FLUI_NFS_EXPORT_UPDATED');
    expect(out).toContain('FLUI_NFS_EXPORT_OK');
    expect(readFileSync(ctx.exportsFile, 'utf8')).toBe(
      `/srv/mine 192.168.1.0/24(ro)\n` +
        `${ctx.share} 10.0.1.0/24(${OPTS}) 10.42.0.0/16(${OPTS})\n`,
    );
    expect(readFileSync(join(ctx.dir, 'calls'), 'utf8')).toContain('ra');
  });

  it('writes nothing the second time', () => {
    const ctx = setup('');
    fakeExportfs(ctx.bin, ctx.exportsFile);
    run(ctx, ['10.0.1.0/24', '10.42.0.0/16']);
    const again = run(ctx, ['10.0.1.0/24', '10.42.0.0/16']);
    expect(again).toContain('FLUI_NFS_EXPORT_UNCHANGED');
    expect(again).not.toContain('FLUI_NFS_EXPORT_UPDATED');
  });

  it('puts the previous file back when the new list is refused', () => {
    const ctx = setup('');
    const original = `${ctx.share} *(${OPTS})\n`;
    writeFileSync(ctx.exportsFile, original);
    fakeExportfs(ctx.bin, ctx.exportsFile);

    const out = run(ctx, ['10.0.1.0/24', '10.42.0.0/16'], { FAKE_FAIL: '1' });

    expect(out).toContain(
      'FLUI_NFS_EXPORT_ROLLBACK: exportfs: bad client list',
    );
    expect(out).not.toContain('FLUI_NFS_EXPORT_OK');
    expect(readFileSync(ctx.exportsFile, 'utf8')).toBe(original);
  });

  it('removes the line when there is no network to share with', () => {
    const ctx = setup('');
    writeFileSync(ctx.exportsFile, `${ctx.share} *(${OPTS})\n/srv/x h(ro)\n`);
    fakeExportfs(ctx.bin, ctx.exportsFile);

    const out = run(ctx, []);

    expect(out).toContain('FLUI_NFS_EXPORT_UPDATED');
    expect(readFileSync(ctx.exportsFile, 'utf8')).toBe('/srv/x h(ro)\n');
  });

  it('does nothing on a node without shared storage', () => {
    const ctx = setup('untouched\n', false);
    fakeExportfs(ctx.bin, ctx.exportsFile);
    const out = run(ctx, ['10.0.1.0/24']);
    expect(out).toContain('FLUI_NFS_EXPORT_ABSENT');
    expect(readFileSync(ctx.exportsFile, 'utf8')).toBe('untouched\n');
  });

  it('says so when the sharing service is missing and cannot be installed', () => {
    const ctx = setup('before\n');
    const out = execFileSync(
      '/bin/sh',
      [
        '-c',
        buildSharedStorageExportScript(['10.0.1.0/24'], {
          exportsFile: ctx.exportsFile,
          sharePath: ctx.share,
        }),
      ],
      { env: { PATH: ctx.bin } },
    ).toString();
    expect(out).toContain('FLUI_NFS_EXPORT_NO_SERVER');
    expect(readFileSync(ctx.exportsFile, 'utf8')).toBe('before\n');
  });
});

describe('SharedStorageExportReconciler', () => {
  const master = (over: any = {}) => ({
    id: 'n-master',
    serverName: 'c-master',
    nodeType: NodeType.MASTER,
    ipAddress: '5.6.7.8',
    privateIp: '10.0.1.2',
    metadata: {},
    ...over,
  });
  const worker = (over: any = {}) => ({
    id: 'n-worker',
    serverName: 'c-worker-1',
    nodeType: NodeType.WORKER,
    ipAddress: '5.6.7.9',
    privateIp: '10.0.1.3',
    metadata: {},
    ...over,
  });
  const cluster = (over: any = {}) => ({
    id: 'c1',
    name: 'workload-1',
    provider: 'hetzner',
    status: ClusterStatus.READY,
    sharedStorageEnabled: true,
    masterIpAddress: '5.6.7.8',
    metadata: { vnetConfig: { vnetId: 'v1', subnetId: 's1' } },
    nodes: [master(), worker()],
    ...over,
  });

  const build = (
    state: any,
    run = jest
      .fn()
      .mockResolvedValue('FLUI_NFS_EXPORT_UPDATED\nFLUI_NFS_EXPORT_OK\n'),
    subnets: any[] = [{ id: 's1', ipRange: '10.0.1.0/24' }],
  ) => {
    const current = { value: state };
    const clusterRepository = {
      findOne: jest.fn(async () => current.value),
      update: jest.fn(async (_id: string, patch: any) => {
        current.value = { ...current.value, ...patch };
      }),
    };
    const subnetRepository = { find: jest.fn().mockResolvedValue(subnets) };
    const reconciler = new SharedStorageExportReconciler(
      clusterRepository as any,
      subnetRepository as any,
      { run } as any,
    );
    return { reconciler, run, clusterRepository, current };
  };

  it('rewrites the export on the master only, from the cluster’s subnet', async () => {
    const { reconciler, run, current } = build(cluster());

    const { record } = await reconciler.reconcile('c1');

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual({
      host: '5.6.7.8',
      port: 22,
      user: 'root',
    });
    expect(run.mock.calls[0][1]).toContain(
      `LINE='/var/lib/flui/storage 10.0.1.0/24(${OPTS}) 10.42.0.0/16(${OPTS})'`,
    );
    expect(record).toMatchObject({
      state: 'applied',
      networks: ['10.0.1.0/24', '10.42.0.0/16'],
      reason: null,
    });
    expect(current.value.metadata.sharedStorageExport.state).toBe('applied');
    expect(current.value.metadata.vnetConfig).toEqual({
      vnetId: 'v1',
      subnetId: 's1',
    });
  });

  it('does not reach the node again while nothing has changed', async () => {
    const { reconciler, run } = build(cluster());
    await reconciler.reconcile('c1');
    const second = await reconciler.reconcile('c1');
    expect(second.skipped).toBe('unchanged');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure even when the networks are the same', async () => {
    const run = jest
      .fn()
      .mockResolvedValueOnce(
        'FLUI_NFS_EXPORT_ROLLBACK: exportfs: bad client list\n',
      )
      .mockResolvedValue('FLUI_NFS_EXPORT_UPDATED\nFLUI_NFS_EXPORT_OK\n');
    const { reconciler } = build(cluster(), run);

    const first = await reconciler.reconcile('c1');
    expect(first.record).toMatchObject({ state: 'failed' });
    expect(first.record?.reason).toContain('previous one was put back');
    expect(first.record?.reason).toContain('exportfs: bad client list');

    const second = await reconciler.reconcile('c1');
    expect(second.record?.state).toBe('applied');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('leaves a multi-node export alone and says why when no private network is known', async () => {
    const { reconciler, run } = build(cluster({ metadata: {} }), undefined, []);
    const { record } = await reconciler.reconcile('c1');
    expect(run).not.toHaveBeenCalled();
    expect(record).toMatchObject({ state: 'blocked' });
    expect(record?.reason).toContain('does not know the private network');
  });

  it('stops sharing on a single node with no known network', async () => {
    const run = jest
      .fn()
      .mockResolvedValue('FLUI_NFS_EXPORT_UPDATED\nFLUI_NFS_EXPORT_OK\n');
    const { reconciler } = build(
      cluster({ metadata: {}, nodes: [master()] }),
      run,
      [],
    );
    const { record } = await reconciler.reconcile('c1');
    expect(run.mock.calls[0][1]).toContain("LINE=''");
    expect(record?.state).toBe('removed');
  });

  it('includes the node networks a BYOS operator declared, and reaches the master on its port', async () => {
    const byos = cluster({
      provider: 'byos',
      metadata: {
        byos: { port: 2222, user: 'ops', nodeNetwork: '192.168.5.0/24' },
      },
      nodes: [
        master({ ipAddress: '203.0.113.4', privateIp: '192.168.5.10' }),
        worker({ ipAddress: '192.168.5.11', privateIp: '192.168.5.11' }),
      ],
    });
    const { reconciler, run } = build(byos, undefined, []);
    const { record } = await reconciler.reconcile('c1');
    expect(run.mock.calls[0][0]).toEqual({
      host: '203.0.113.4',
      port: 2222,
      user: 'ops',
    });
    expect(record?.networks).toEqual([
      '192.168.5.0/24',
      '192.168.5.10/32',
      '192.168.5.11/32',
      '10.42.0.0/16',
    ]);
  });

  it('does nothing when shared storage is off', async () => {
    const { reconciler, run } = build(cluster({ sharedStorageEnabled: false }));
    expect((await reconciler.reconcile('c1')).skipped).toBe('disabled');
    expect(run).not.toHaveBeenCalled();
  });

  it('records an unreachable master as a failure with the reason', async () => {
    const run = jest
      .fn()
      .mockRejectedValue(
        new ServiceUnavailableException('Connection timed out'),
      );
    const { reconciler } = build(cluster(), run);
    const { record } = await reconciler.reconcile('c1');
    expect(record?.state).toBe('failed');
    expect(record?.reason).toContain('could not be reached');
    expect(record?.reason).toContain('5.6.7.8:22');
  });

  it('records a master without shared storage without treating it as an error', async () => {
    const run = jest
      .fn()
      .mockResolvedValue('FLUI_NFS_EXPORT_ABSENT\nFLUI_NFS_EXPORT_OK\n');
    const { reconciler } = build(cluster(), run);
    const { record } = await reconciler.reconcile('c1');
    expect(record?.state).toBe('not-present');
  });

  it('never runs two rewrites of the same cluster at once', async () => {
    let active = 0;
    let peak = 0;
    const run = jest.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return 'FLUI_NFS_EXPORT_UPDATED\nFLUI_NFS_EXPORT_OK\n';
    });
    const { reconciler } = build(cluster(), run);
    await Promise.all([
      reconciler.reconcile('c1', { force: true }),
      reconciler.reconcile('c1', { force: true }),
    ]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });
});

describe('shared storage export on BYOS join paths', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ClusterOperationsService } = require('./cluster-operations.service');

  it('reconciles when a node network is declared, not on other metadata', async () => {
    const reconcileSoon = jest.fn();
    const clusterRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 'c1', metadata: {} }),
      save: jest.fn(async (c: any) => c),
    };
    const service = new ClusterOperationsService(
      clusterRepository,
      {},
      {},
      { mapToDto: (c: any) => c },
      {},
      {},
      { reconcileSoon },
    );

    await service.updateClusterMetadata('c1', { acmeStaging: true });
    expect(reconcileSoon).not.toHaveBeenCalled();

    await service.updateClusterMetadata('c1', {
      byos: { port: 22, user: 'root', nodeNetwork: '10.0.0.0/24' },
    });
    expect(reconcileSoon).toHaveBeenCalledWith(
      'c1',
      'a node network was declared',
    );
  });
});
