jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { load } from 'js-yaml';
import { DbPoolerCutService, poolerCutApplies } from './db-pooler-cut.service';

const SHOW_EMPTY = [
  '@@ CLIENTS',
  'type|user|database|ptr|link|id',
  '@@ SERVERS',
  'type|user|database|ptr|link|remote_pid',
].join('\n');

const SHOW_HELD = [
  '@@ CLIENTS',
  'type|user|database|ptr|link|id|application_name|addr|request_time',
  'C|app|app_db|0xc1|0xs1|17|worker|10.42.1.7|2026-10-12 10:00:01 UTC',
  '@@ SERVERS',
  'type|user|database|ptr|link|remote_pid|request_time',
  'S|app|app_db|0xs1|0xc1|4242|2026-10-12 10:00:01 UTC',
].join('\n');

/** Each read of the clock moves it a second on, so every wait reaches its end. */
function ticking(): () => void {
  let t = Date.parse('2026-10-12T10:00:00Z');
  const spy = jest.spyOn(Date, 'now').mockImplementation(() => (t += 1_000));
  return () => spy.mockRestore();
}

function pooler(upstream: any = { mode: 'local' }) {
  return {
    enabled: true,
    mode: 'transaction',
    replicas: 1,
    image: 'pgbouncer',
    authPasswordEnc: 'a',
    adminPasswordEnc: 'b',
    upstream,
    upstreamClusterIP: '10.43.9.9',
    routed: true,
  };
}

function setup(over: Record<string, any> = {}) {
  const calls: string[] = [];
  const apps: Record<string, any> = {
    src: { id: 'src', slug: 'pg-a', k8sNamespace: 'p1', pooler: pooler() },
    dst: { id: 'dst', slug: 'pg-b', k8sNamespace: 'p1', pooler: pooler() },
    ...over.apps,
  };
  const appRepo = {
    findOne: jest.fn(async ({ where }: any) => ({ ...apps[where.id] })),
    update: jest.fn(async (id: string, p: any) => {
      Object.assign(apps[id], p);
      calls.push(`row:${id}:${p.pooler?.upstream?.mode}`);
    }),
  };
  const migRepo = { update: jest.fn(async () => ({ affected: 1 })) };
  let show = over.show ?? SHOW_EMPTY;
  const paused = new Set<string>(over.paused ?? []);
  const queued = new Map<string, number>();
  const showOf = (pod: string) => {
    const waiting = queued.get(pod) ?? 0;
    if (waiting > 0) queued.set(pod, waiting - 1);
    return [
      '@@ POOLS',
      'database|user|cl_active|cl_waiting',
      `app_db|app|0|${waiting > 0 ? 1 : 0}`,
      show,
      '@@ DATABASES',
      'name|paused',
      `app_db|${paused.has(pod) ? 1 : 0}`,
    ].join('\n');
  };
  const k8s = {
    listPodsByLabel: jest.fn(async (_k: string, _ns: string, sel: string) => {
      if (sel.startsWith('flui.cloud/pooler-of=')) {
        const id = sel.split('=')[1];
        return [
          {
            metadata: { name: `${apps[id].slug}-pooler-1` },
            status: { phase: 'Running' },
            spec: { nodeName: over.poolerNode ?? `node-${id}` },
          },
        ];
      }
      const id = sel.split('=')[1];
      return [
        {
          metadata: { name: `${apps[id].slug}-0` },
          status: {
            phase: 'Running',
            podIP: over.noPodIp ? undefined : `10.42.0.${id === 'src' ? 2 : 3}`,
          },
          spec: { nodeName: `node-${id}` },
        },
      ];
    }),
    getResource: jest.fn(over.getResource ?? (async () => null)),
    deleteResource: jest.fn(async (_k: string, kind: string, name: string) => {
      calls.push(`delete:${kind}/${name}`);
    }),
    applyManifest: jest.fn(async (_k: string, yaml: string) => {
      const doc = load(yaml) as any;
      if (over.applyFails?.(doc, applied)) {
        calls.push(`apply-failed:${doc.kind}/${doc.metadata.name}`);
        throw new Error(`apply failed: ${doc.kind}`);
      }
      calls.push(`apply:${doc.kind}/${doc.metadata.name}`);
      applied.push(doc);
      return [];
    }),
    listResourcesByLabel: jest.fn(async () => [
      {
        metadata: { labels: {} },
        endpoints: [{ addresses: ['10.42.0.3'], conditions: { ready: true } }],
      },
    ]),
    execInPod: jest.fn(
      async (
        _k: string,
        _ns: string,
        _sel: string,
        _c: string,
        cmd: string[],
        pod: string,
      ) => {
        const script = cmd[2];
        if (over.execFails?.(script, pod))
          throw new Error(`exec failed on ${pod}`);
        if (script.includes('whoami()')) {
          calls.push(`probe:${pod}`);
          return over.whoami?.(pod) ?? 'f|7301|3|10.42.0.2\n';
        }
        if (script.includes('nohup')) {
          const cmd = /-c '([A-Z_]+)/.exec(script)?.[1];
          calls.push(`bg:${cmd}:${pod}`);
          if (cmd === 'PAUSE' && !over.neverPaused?.(pod)) paused.add(pod);
          return '';
        }
        if (script.includes('SHOW POOLS')) {
          calls.push(`show:${pod}`);
          return showOf(pod);
        }
        const cmds = [...script.matchAll(/-c '([^']+)'/g)].map((m) => m[1]);
        calls.push(`admin:${cmds.join(' ')}:${pod}`);
        if (cmds.some((c) => c.startsWith('RESUME'))) {
          if (over.resumeFails?.(pod)) {
            if (over.resumedElsewhere) paused.delete(pod);
            throw new Error(`RESUME failed on ${pod}`);
          }
          paused.delete(pod);
          show = SHOW_EMPTY;
          queued.set(pod, over.queued ?? 0);
        }
        return '';
      },
    ),
  };
  const applied: any[] = [];
  const sqls: string[] = [];
  const db = (id: string) => ({
    appId: id,
    kubeconfig: `kc-${id}`,
    namespace: 'p1',
    labelSelector: `flui-app-id=${id}`,
    pgDb: 'app_db',
    slug: apps[id].slug,
  });
  const exec = {
    resolve: jest.fn(async (id: string) => db(id)),
    execRaw: jest.fn(async (t: any, script: string) => {
      calls.push(
        script.includes('host app_db all')
          ? `hba-fwd:${t.appId}`
          : script.includes(':begin$/,/^#')
            ? `hba-remove:${t.appId}`
            : `raw:${t.appId}`,
      );
      return '';
    }),
    execSql: jest.fn(async (_t: any, sql: string) => {
      if (sql.includes('pg_control_system')) {
        sqls.push(sql);
        return '7301|3\n';
      }
      if (sql.includes('pg_hba_file_rules')) return '0\n';
      return '';
    }),
  };
  const poolers = {
    ensureRole: jest.fn(async (app: any) =>
      calls.push(`ensure-role:${app.id}`),
    ),
  };
  const physical = {
    getLink: jest.fn(async () => ({
      id: '0123456789ab-0000',
      srcAppId: 'src',
      dstAppId: 'dst',
      transport: {
        mode: 'overlay',
        host: '10.250.0.2',
        port: 15432,
        dstHost: '10.250.0.3',
      },
    })),
  };
  const svc = new DbPoolerCutService(
    appRepo as any,
    migRepo as any,
    k8s as any,
    exec as any,
    poolers as any,
    physical as any,
  );
  (svc as any).sleep = jest.fn(async () => undefined);
  return {
    svc,
    calls,
    apps,
    applied,
    k8s,
    migRepo,
    sqls,
    paused,
    setShow: (s: string) => (show = s),
  };
}

describe('DbPoolerCutService', () => {
  it('applies only to a routed source pooler with a destination pooler', () => {
    expect(
      poolerCutApplies(
        { pooler: pooler() as any },
        { pooler: pooler() as any },
      ),
    ).toBe(true);
    expect(
      poolerCutApplies({ pooler: null }, { pooler: pooler() as any }),
    ).toBe(false);
    expect(
      poolerCutApplies(
        { pooler: { ...pooler(), routed: false } as any },
        { pooler: pooler() as any },
      ),
    ).toBe(false);
    expect(
      poolerCutApplies({ pooler: pooler() as any }, { pooler: null }),
    ).toBe(false);
  });

  describe('forward', () => {
    it('sets the role up on the source, admits the destination node, then repoints the upstream without merging a selector away', async () => {
      const { svc, calls, apps, applied } = setup();
      const source = await svc.forward('l1');
      expect(source).toEqual({ systemIdentifier: '7301', timeline: 3 });
      expect(calls.slice(0, 7)).toEqual([
        'ensure-role:src',
        'hba-fwd:src',
        'apply:NetworkPolicy/flui-db-fwd-0123456789ab',
        'delete:Service/pg-b-pooler-upstream',
        'apply:Service/pg-b-pooler-upstream',
        'apply:EndpointSlice/pg-b-pooler-upstream-fwd',
        'row:dst:forward',
      ]);
      const service = applied.find((d) => d.kind === 'Service');
      expect(service.spec.selector).toBeUndefined();
      expect(service.spec.clusterIP).toBe('10.43.9.9');
      expect(service.spec.ports[0].targetPort).toBe(15432);
      const slice = applied.find((d) => d.kind === 'EndpointSlice');
      expect(slice.endpoints[0].addresses).toEqual(['10.250.0.2']);
      expect(apps.dst.pooler.upstream).toEqual({
        mode: 'forward',
        address: '10.250.0.2',
        port: 15432,
        linkId: '0123456789ab-0000',
      });
      expect(calls).toContain('bg:PAUSE:pg-b-pooler-1');
      expect(calls).toContain('admin:RESUME "app_db";:pg-b-pooler-1');
      expect(calls[calls.length - 1]).toBe('probe:pg-b-pooler-1');
    });

    it('keeps DNS and the cluster open to the pooler pods it lets dial the source, and reads the insert timeline', async () => {
      const { svc, applied, sqls } = setup();
      await svc.forward('l1');
      const policy = applied.find((d) => d.kind === 'NetworkPolicy');
      expect(policy.spec.egress[1].ports).toEqual([
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ]);
      expect(policy.spec.egress[2].to.map((t: any) => t.ipBlock.cidr)).toEqual(
        expect.arrayContaining(['10.42.0.0/16', '10.43.0.0/16']),
      );
      expect(sqls[0]).toContain('pg_walfile_name(pg_current_wal_lsn())');
      expect(sqls[0]).toContain('pg_is_in_recovery()');
    });

    it('stores the upstream address before deleting the Service, and puts the old Service back when the new one is refused', async () => {
      let reads = 0;
      let failed = false;
      const { svc, calls, apps, applied } = setup({
        apps: {
          dst: {
            id: 'dst',
            slug: 'pg-b',
            k8sNamespace: 'p1',
            pooler: { ...pooler(), upstreamClusterIP: undefined },
          },
        },
        getResource: async () =>
          reads++ === 0 ? { spec: { clusterIP: '10.43.7.7' } } : null,
        applyFails: (doc: any) => {
          if (doc.kind !== 'Service' || failed) return false;
          failed = true;
          return true;
        },
      });
      await expect(svc.forward('l1')).rejects.toThrow(/apply failed/);
      const del = calls.indexOf('delete:Service/pg-b-pooler-upstream');
      expect(calls.indexOf('row:dst:local')).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf('row:dst:local')).toBeLessThan(del);
      expect(apps.dst.pooler.upstreamClusterIP).toBe('10.43.7.7');
      expect(calls.slice(del + 1)).toEqual([
        'apply-failed:Service/pg-b-pooler-upstream',
        'apply:Service/pg-b-pooler-upstream',
      ]);
      const restored = applied.find((d) => d.kind === 'Service');
      expect(restored.spec.selector).toEqual({ app: 'pg-b' });
      expect(restored.spec.clusterIP).toBe('10.43.7.7');
      expect(apps.dst.pooler.upstream).toEqual({ mode: 'local' });
    });

    it('tolerates a RESUME the sweeper got to first while cycling, and fails one that left the pooler paused', async () => {
      const ok = setup({
        resumeFails: (pod: string) => pod === 'pg-b-pooler-1',
        resumedElsewhere: true,
      });
      await expect(ok.svc.forward('l1')).resolves.toEqual({
        systemIdentifier: '7301',
        timeline: 3,
      });
      const stuck = setup({
        resumeFails: (pod: string) => pod === 'pg-b-pooler-1',
      });
      await expect(stuck.svc.forward('l1')).rejects.toThrow(/RESUME failed/);
    });

    it('refuses before touching anything when a pooler pod is not on the database node', async () => {
      const { svc, calls } = setup({ poolerNode: 'elsewhere' });
      await expect(svc.forward('l1')).rejects.toThrow(
        /does not run on the node/,
      );
      expect(calls).toEqual(['ensure-role:src']);
    });

    it('fails when the probe still sees the standby', async () => {
      const { svc } = setup({ whoami: () => 't|7301|3|10.42.0.3\n' });
      const restore = ticking();
      await expect(svc.forward('l1')).rejects.toThrow(
        /does not reach forwarding to the source primary/,
      );
      restore();
    });

    it('undoes the forward: slice first, Service with its selector back, policy and hba block gone', async () => {
      const { svc, calls, applied, apps } = setup({
        apps: {
          dst: {
            id: 'dst',
            slug: 'pg-b',
            k8sNamespace: 'p1',
            pooler: pooler({
              mode: 'forward',
              address: '10.250.0.2',
              port: 15432,
              linkId: 'l',
            }),
          },
        },
      });
      expect(await svc.unforward('l1')).toEqual([]);
      expect(calls.slice(0, 4)).toEqual([
        'delete:EndpointSlice/pg-b-pooler-upstream-fwd',
        'delete:Service/pg-b-pooler-upstream',
        'apply:Service/pg-b-pooler-upstream',
        'row:dst:local',
      ]);
      expect(applied[0].spec.selector).toEqual({ app: 'pg-b' });
      expect(apps.dst.pooler.upstream).toEqual({ mode: 'local' });
      expect(calls).toContain('delete:NetworkPolicy/flui-db-fwd-0123456789ab');
      expect(calls[calls.length - 1]).toBe('hba-remove:src');
    });
  });

  describe('pause and resume', () => {
    const mig = () => ({
      id: 'm1',
      poolerCut: {
        poolers: [
          { appId: 'src', role: 'source' },
          { appId: 'dst', role: 'destination' },
        ],
        deadlineMs: 5000,
        sourceSystemIdentifier: '7301',
        sourceTimeline: 3,
      },
    });

    it('raises the waits and starts PAUSE on every pod, then records a clean drain', async () => {
      const { svc, calls } = setup();
      const m: any = mig();
      const record = await svc.pause(m, 120_000, async () => undefined);
      expect(calls).toEqual(
        expect.arrayContaining([
          'admin:SET query_wait_timeout = 240; SET client_login_timeout = 240;:pg-a-pooler-1',
          'bg:PAUSE:pg-a-pooler-1',
          'admin:SET query_wait_timeout = 240; SET client_login_timeout = 240;:pg-b-pooler-1',
          'bg:PAUSE:pg-b-pooler-1',
        ]),
      );
      expect(record.pausedAt).toBeTruthy();
      expect(record.drainedAt).toBeTruthy();
      expect(record.cut).toEqual([]);
      expect(record.pausedPods).toHaveLength(2);
    });

    it('records who still holds a server at the deadline', async () => {
      const { svc } = setup({ show: SHOW_HELD });
      const m: any = mig();
      m.poolerCut.deadlineMs = 0;
      const record = await svc.pause(m, 120_000, async () => undefined);
      expect(record.drainedAt).toBeUndefined();
      expect(record.cut).toHaveLength(2);
      expect(record.cut?.[0]).toMatchObject({
        role: 'source',
        remotePid: 4242,
        clientApp: 'worker',
      });
    });

    it('resumes every pod when one cannot be paused', async () => {
      const { svc, calls } = setup({
        execFails: (script: string, pod: string) =>
          pod === 'pg-b-pooler-1' && script.includes('nohup'),
      });
      const m: any = mig();
      await expect(
        svc.pause(m, 120_000, async () => undefined),
      ).rejects.toThrow(/could not be paused: exec failed on pg-b-pooler-1/);
      expect(calls).toEqual(
        expect.arrayContaining([
          'admin:RESUME "app_db";:pg-a-pooler-1',
          'admin:RELOAD;:pg-a-pooler-1',
        ]),
      );
    });

    it('takes the could-not-be-paused path when a pod never reports the database paused', async () => {
      const { svc, calls } = setup({
        neverPaused: (pod: string) => pod === 'pg-b-pooler-1',
      });
      const m: any = mig();
      const restore = ticking();
      await expect(
        svc.pause(m, 120_000, async () => undefined),
      ).rejects.toThrow(
        /could not be paused: pg-b-pooler-1 did not report app_db paused/,
      );
      restore();
      expect(m.poolerCut.pausedAt).toBeUndefined();
      expect(m.poolerCut.resumedBy).toBe('rollback');
      expect(calls).toContain('admin:RESUME "app_db";:pg-a-pooler-1');
    });

    it('starts a fresh pause record, none of the earlier attempt carried over', async () => {
      const { svc } = setup();
      const m: any = mig();
      Object.assign(m.poolerCut, {
        pausedPods: [{ appId: 'src', pod: 'old-pod' }],
        pausedAt: '2026-10-12T09:00:00.000Z',
        drainedAt: '2026-10-12T09:00:01.000Z',
        fencedAt: '2026-10-12T09:00:02.000Z',
        cut: [{ pod: 'old-pod' }],
        resumedAt: '2026-10-12T09:00:03.000Z',
        resumedBy: 'rollback',
        notes: ['old'],
      });
      const record = await svc.pause(m, 120_000, async () => undefined);
      expect(record.pausedAt).not.toBe('2026-10-12T09:00:00.000Z');
      expect(record.fencedAt).toBeUndefined();
      expect(record.resumedAt).toBeUndefined();
      expect(record.resumedBy).toBeUndefined();
      expect(record.notes).toBeUndefined();
      expect(record.pausedPods).toEqual([
        { appId: 'src', pod: 'pg-a-pooler-1' },
        { appId: 'dst', pod: 'pg-b-pooler-1' },
      ]);
      expect(record.sourceTimeline).toBe(3);
    });

    it('records when and why a rollback or an abort resumed the poolers', async () => {
      for (const by of ['rollback', 'abort'] as const) {
        const { svc, migRepo } = setup({
          paused: ['pg-a-pooler-1', 'pg-b-pooler-1'],
        });
        const m: any = mig();
        m.poolerCut.pausedPods = [
          { appId: 'src', pod: 'pg-a-pooler-1' },
          { appId: 'dst', pod: 'pg-b-pooler-1' },
        ];
        m.poolerCut.pausedAt = '2026-10-12T10:00:00.000Z';
        expect(await svc.resumeRoles(m, ['source', 'destination'], by)).toEqual(
          [],
        );
        expect(m.poolerCut.resumedAt).toBeTruthy();
        expect(m.poolerCut.resumedBy).toBe(by);
        expect(migRepo.update).toHaveBeenLastCalledWith('m1', {
          poolerCut: m.poolerCut,
        });
      }
    });

    it('keeps the pause open on the record when a pod could not be resumed', async () => {
      const { svc } = setup({
        paused: ['pg-b-pooler-1'],
        resumeFails: (pod: string) => pod === 'pg-b-pooler-1',
      });
      const m: any = mig();
      m.poolerCut.pausedPods = [{ appId: 'dst', pod: 'pg-b-pooler-1' }];
      m.poolerCut.pausedAt = '2026-10-12T10:00:00.000Z';
      const notes = await svc.resumeRoles(m, ['destination'], 'abort');
      expect(notes[0]).toMatch(/pg-b-pooler-1 not resumed/);
      expect(m.poolerCut.resumedAt).toBeUndefined();
    });

    it('closes the clients still linked to a server after the fence', async () => {
      const { svc, calls } = setup({ show: SHOW_HELD });
      const m: any = mig();
      m.poolerCut.deadlineMs = 0;
      await svc.pause(m, 120_000, async () => undefined);
      const restore = ticking();
      await svc.settleAfterFence(m, async () => undefined);
      restore();
      expect(
        calls.filter((c) => c.startsWith('admin:KILL_CLIENT 17')),
      ).toHaveLength(2);
      expect(m.poolerCut.fencedAt).toBeTruthy();
    });

    it('retargets the destination, proves the promoted copy, then resumes it alone', async () => {
      const { svc, calls, apps } = setup({
        apps: {
          dst: {
            id: 'dst',
            slug: 'pg-b',
            k8sNamespace: 'p1',
            pooler: pooler({
              mode: 'forward',
              address: '10.250.0.2',
              port: 15432,
              linkId: 'l',
            }),
          },
        },
        whoami: () => 'f|7301|4|10.42.0.3\n',
      });
      const m: any = mig();
      m.poolerCut.pausedPods = [
        { appId: 'src', pod: 'pg-a-pooler-1' },
        { appId: 'dst', pod: 'pg-b-pooler-1' },
      ];
      m.poolerCut.pausedAt = new Date().toISOString();
      const record = await svc.retargetAndResume(m, async () => undefined);
      expect(apps.dst.pooler.upstream).toEqual({ mode: 'local' });
      expect(calls).toContain('admin:RESUME "app_db";:pg-b-pooler-1');
      expect(calls).not.toContain('admin:RESUME "app_db";:pg-a-pooler-1');
      expect(record.resumedAt).toBeTruthy();
      expect(record.resumedBy).toBe('retarget');
      expect(record.sourceLeftPaused).toBe(true);
    });

    const forwarding = () => ({
      dst: {
        id: 'dst',
        slug: 'pg-b',
        k8sNamespace: 'p1',
        pooler: pooler({
          mode: 'forward',
          address: '10.250.0.2',
          port: 15432,
          linkId: '0123456789ab-0000',
        }),
      },
    });

    it('drops the forward egress policy right after the switch back, before probing', async () => {
      const { svc, calls } = setup({
        apps: forwarding(),
        whoami: () => 'f|7301|4|10.42.0.3\n',
      });
      const m: any = mig();
      m.linkId = '0123456789ab-0000';
      m.poolerCut.pausedPods = [{ appId: 'dst', pod: 'pg-b-pooler-1' }];
      m.poolerCut.pausedAt = new Date().toISOString();
      await svc.retargetAndResume(m, async () => undefined);
      const row = calls.indexOf('row:dst:local');
      const drop = calls.indexOf(
        'delete:NetworkPolicy/flui-db-fwd-0123456789ab',
      );
      const probe = calls.indexOf('probe:pg-b-pooler-1');
      expect(row).toBeGreaterThanOrEqual(0);
      expect(drop).toBeGreaterThan(row);
      expect(probe).toBeGreaterThan(drop);
    });

    it('restores the configured waits only once the queue drained after RESUME', async () => {
      const { svc, calls } = setup({
        apps: forwarding(),
        whoami: () => 'f|7301|4|10.42.0.3\n',
        queued: 2,
      });
      const m: any = mig();
      m.poolerCut.pausedPods = [{ appId: 'dst', pod: 'pg-b-pooler-1' }];
      m.poolerCut.pausedAt = new Date().toISOString();
      await svc.retargetAndResume(m, async () => undefined);
      const resume = calls.lastIndexOf('admin:RESUME "app_db";:pg-b-pooler-1');
      const reload = calls.lastIndexOf('admin:RELOAD;:pg-b-pooler-1');
      expect(reload).toBeGreaterThan(resume);
      expect(
        calls
          .slice(resume + 1, reload)
          .filter((c) => c === 'show:pg-b-pooler-1'),
      ).toHaveLength(3);
    });

    it('fails loudly, and resumes nothing, when the destination pod address cannot be read', async () => {
      const { svc, calls } = setup({
        apps: forwarding(),
        whoami: () => 'f|7301|4|10.42.0.3\n',
        noPodIp: true,
      });
      const m: any = mig();
      m.poolerCut.pausedPods = [{ appId: 'dst', pod: 'pg-b-pooler-1' }];
      m.poolerCut.pausedAt = new Date().toISOString();
      const restore = ticking();
      await expect(
        svc.retargetAndResume(m, async () => undefined),
      ).rejects.toThrow(/has no address to tell the promoted copy by/);
      restore();
      expect(calls.some((c) => c.startsWith('admin:RESUME'))).toBe(false);
    });

    it('never resumes the destination while the probe still sees the source', async () => {
      const { svc, calls } = setup({ whoami: () => 'f|7301|3|10.42.0.2\n' });
      const m: any = mig();
      m.poolerCut.pausedPods = [{ appId: 'dst', pod: 'pg-b-pooler-1' }];
      m.poolerCut.pausedAt = new Date(Date.now() - 600_000).toISOString();
      m.poolerCut.budgetMs = 0;
      const restore = ticking();
      await expect(
        svc.retargetAndResume(m, async () => undefined),
      ).rejects.toThrow(/does not reach the promoted destination/);
      restore();
      expect(calls.some((c) => c.startsWith('admin:RESUME'))).toBe(false);
    });

    it('marks the source pooler suspended for the sweeper', async () => {
      const { svc, apps } = setup();
      await svc.suspendSource(mig() as any);
      expect(apps.src.pooler.suspended).toBe(true);
    });
  });
});
