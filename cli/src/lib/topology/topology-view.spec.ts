jest.mock('chalk', () => {
  const same = (text: string) => text;
  const chalk: any = new Proxy(same, { get: () => chalk });
  return { __esModule: true, default: chalk };
});

import { exampleTopology } from '../../../../src/modules/sandbox/stand-in/sandbox-world-topology';
import { pathTo, topologyView, viewLines } from './topology-view';
import { row, truncate } from './topology-format';

const QUIET = 1792663200000;
const t = exampleTopology(QUIET);
const lines = (screen: Parameters<typeof topologyView>[1], system = false) =>
  viewLines(topologyView(t, screen, { system })!);

describe('topology views', () => {
  it('keeps every view within 80 columns', () => {
    const screens = [
      { type: 'fleet' as const },
      ...t.clusters.map((c) => ({ type: 'cluster' as const, id: c.id })),
      ...t.apps.map((a) => ({ type: 'app' as const, id: a.id })),
      ...t.servers.map((s) => ({ type: 'server' as const, id: s.id })),
      { type: 'platform' as const, id: 'example-cluster-3' },
    ];
    for (const screen of screens) {
      for (const system of [false, true]) {
        const wide = lines(screen, system).filter((l) => l.length > 80);
        expect({ screen, wide }).toEqual({ screen, wide: [] });
      }
    }
  });

  it('shows the fleet with clusters, what needs attention and what is spread', () => {
    const out = lines({ type: 'fleet' });
    expect(out[0]).toBe('Fleet');
    expect(out[1]).toBe(
      '3 clusters · 5 servers · 11 apps · 13 replicas · 12 platform apps',
    );
    expect(out).toContain(
      '  production          hetzner · fsn1                3      8         1  Healthy',
    );
    expect(out.join('\n')).toContain(
      'Needs attention\n  ● Worker           production   Restarted 3 times in the last hour · OOMKilled\n',
    );
    expect(out).toContain('Spread across clusters');
  });

  it('groups a cluster by project, stacks first, with type, replicas, status and traffic', () => {
    const out = lines({ type: 'cluster', id: 'example-cluster-1' });
    expect(out[0]).toBe('Fleet › production');
    expect(out[2]).toBe('3 servers · 8 apps in 2 projects · 1 problem');
    const shop = out.indexOf('Shop');
    expect(out[shop + 1]).toBe(
      '  APP                   TYPE             REPLICAS  STATUS      REQ/S  EXPOSURE',
    );
    expect(out[shop + 2]).toBe(
      '  API                   Web app                 2  Running         —  internal',
    );
    expect(out.slice(shop, shop + 8).join('\n')).toContain('Worker');
    expect(out).toContain('    Restarted 3 times in the last hour · OOMKilled');
    expect(out).toContain('Website');
    expect(out).toContain('Servers');
  });

  it('counts the apps outside any project apart', () => {
    const loose = {
      ...t,
      apps: t.apps.map((a) =>
        a.id === 'example-app-1' ? { ...a, projectId: null } : a,
      ),
    };
    const out = viewLines(
      topologyView(
        loose,
        { type: 'cluster', id: 'example-cluster-1' },
        { system: false },
      )!,
    );
    expect(out[2]).toBe(
      '3 servers · 8 apps in 2 projects, 1 in none · 1 problem',
    );
    expect(out).toContain('No project');
  });

  it('says apart what anyone can reach and what only some ranges can', () => {
    const out = lines({ type: 'cluster', id: 'example-cluster-1' });
    expect(out.slice(4, 6)).toEqual([
      'Public:  :80 HTTP, :443 HTTPS',
      'Limited: :22 SSH (1 range), :6443 Kubernetes API (1 range)',
    ]);
  });

  it('keeps the firewall on one line when it fits, and drops whole ports when it does not', () => {
    const rule = (port: string, description: string, fromAnywhere = true) => ({
      protocol: 'tcp' as const,
      port,
      description,
      fromAnywhere,
      sourceCount: fromAnywhere ? 2 : 1,
    });
    const withRules = (inbound: ReturnType<typeof rule>[]) =>
      viewLines(
        topologyView(
          {
            ...t,
            clusters: t.clusters.map((c) =>
              c.id === 'example-cluster-2' ? { ...c, inbound } : c,
            ),
          },
          { type: 'cluster', id: 'example-cluster-2' },
          { system: false },
        )!,
      );
    expect(
      withRules([
        rule('443', 'HTTPS Ingress (Traefik)'),
        rule('22', 'SSH access for cluster management', false),
      ])[4],
    ).toBe('Public: :443 HTTPS · Limited: :22 SSH (1 range)');
    const many = withRules(
      Array.from({ length: 12 }, (_, i) =>
        rule(String(8000 + i), `Service number ${i}, internal`),
      ),
    );
    expect(many[4]).toMatch(
      /^Public: {2}:8000 Service number 0, .* \+\d+ more$/,
    );
    expect(many[4].length).toBeLessThanOrEqual(78);
  });

  it('folds the platform apps into one entry unless asked to list them', () => {
    const folded = lines({ type: 'cluster', id: 'example-cluster-3' });
    expect(folded.some((l) => l.startsWith('  Flui platform (12)'))).toBe(true);
    expect(folded.some((l) => l.startsWith('  Zitadel'))).toBe(false);
    const listed = lines({ type: 'cluster', id: 'example-cluster-3' }, true);
    expect(listed.some((l) => l.startsWith('  Zitadel'))).toBe(true);
  });

  it('tells an app’s story: traffic, callers, dependencies and servers', () => {
    const out = lines({ type: 'app', id: 'example-app-1' }).join('\n');
    expect(out).toContain('Fleet › production › Storefront');
    expect(out).toContain('Storefront  Running  production · public · Web app');
    expect(out).toContain('Reachable from the Internet\n  https://shop.');
    expect(out).toContain('Talks to\n  API ');
    expect(out).toMatch(/Runs on\n {2}production-2 +×1/);
  });

  it('puts the reason under a troubled app’s title', () => {
    const out = lines({ type: 'app', id: 'example-app-4' });
    expect(out[2]).toBe('Restarted 3 times in the last hour · OOMKilled');
  });

  it('shows what runs on a server', () => {
    const out = lines({ type: 'server', id: 'example-server-2' }).join('\n');
    expect(out).toContain('Fleet › production › production-2');
    expect(out).toMatch(/Role +worker · takes work/);
    expect(out).toMatch(/Storefront +×1 +Running/);
  });

  it('places a platform app under its cluster’s platform', () => {
    const app = t.apps.find((a) => a.kind === 'system')!;
    expect(pathTo(t, { type: 'app', id: app.id }).map((s) => s.type)).toEqual([
      'fleet',
      'cluster',
      'platform',
      'app',
    ]);
  });

  it('answers null for something no longer on the map', () => {
    expect(
      topologyView(t, { type: 'app', id: 'gone' }, { system: false }),
    ).toBeNull();
  });
});

describe('table cells', () => {
  it('cuts and pads before painting, so colour never moves a column', () => {
    const paint = (s: string) => `<${s}>`;
    expect(
      row(
        [{ width: 4 }, { width: 3, align: 'right' }],
        [{ text: 'abcdef', paint }, '7'],
      ),
    ).toBe('<abc…>    7');
    expect(truncate('abc', 3)).toBe('abc');
  });
});
