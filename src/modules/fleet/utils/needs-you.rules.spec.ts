import {
  CredentialKind,
  CredentialStatus,
} from '../../repositories/dto/ghcr-pat.dto';
import { ClusterStatus } from '../../infrastructure/clusters/entities/cluster.entity';
import type { AppCoverageRow } from '../../backups/services/app-coverage.service';
import {
  assembleNeedsYou,
  backupItem,
  clusterItems,
  credentialItems,
} from './needs-you.rules';

const NOW = new Date('2026-09-27T12:00:00Z');

const cluster = (status: string, name = 'wc-1') => ({
  id: `id-${name}`,
  name,
  provider: 'hetzner',
  status,
});

const row = (over: Partial<AppCoverageRow>): AppCoverageRow => ({
  applicationId: 'a',
  name: 'app',
  slug: 'app',
  kind: 'APPLICATION',
  category: 'user',
  clusterId: 'c1',
  clusterName: 'wc-1',
  holdsData: true,
  dataReasons: ['volume'],
  coverage: 'unprotected',
  reason: 'no_policy',
  alarm: true,
  policy: null,
  coveringPolicies: 0,
  lastSuccessAt: null,
  protectedUntil: null,
  protectPath: null,
  ...over,
});

describe('clusterItems', () => {
  it('turns broken clusters into actions and running ones into notices', () => {
    const items = clusterItems([
      cluster(ClusterStatus.READY, 'fine'),
      cluster(ClusterStatus.ERROR, 'bad'),
      cluster(ClusterStatus.LOST, 'gone'),
      cluster(ClusterStatus.DELETION_FAILED, 'stuck'),
      cluster(ClusterStatus.CREATING, 'new'),
    ]);
    expect(items.map((i) => [i.kind, i.level, i.title])).toEqual([
      ['cluster_broken', 'critical', 'bad is in error'],
      ['cluster_broken', 'critical', 'gone is lost'],
      ['cluster_broken', 'warning', 'Removing stuck did not finish'],
      ['cluster_operation', 'info', 'new is being created'],
    ]);
    expect(items[0].action).toEqual({
      label: 'Open cluster',
      path: '/cluster/id-bad/overview',
    });
    expect(items[3].action).toBeNull();
  });
});

describe('credentialItems', () => {
  const base = {
    label: 'GitHub App',
    expiresAt: null,
    daysUntilExpiry: null,
  };

  it('raises what the banner raised and nothing that is valid', () => {
    const items = credentialItems([
      {
        ...base,
        kind: CredentialKind.GITHUB_APP,
        status: CredentialStatus.VALID,
      },
      {
        ...base,
        kind: CredentialKind.PROVIDER,
        providerId: 'hetzner',
        label: 'hetzner',
        status: CredentialStatus.EXPIRING_SOON,
        daysUntilExpiry: 3,
        actionUrl: '/management/providers/hetzner',
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'credential:provider:hetzner',
      level: 'warning',
      title: 'hetzner expires soon',
      detail: 'In 3 days',
      action: { label: 'Manage', path: '/management/providers/hetzner' },
      credential: { kind: 'provider', status: 'expiring_soon' },
    });
  });

  it('tells an unlinked account from an installation without a GitHub App', () => {
    const [linked, setup] = credentialItems([
      {
        ...base,
        kind: CredentialKind.GITHUB_APP,
        status: CredentialStatus.MISSING,
        actionUrl: '/apps/repositories',
      },
      {
        ...base,
        kind: CredentialKind.GITHUB_APP,
        status: CredentialStatus.MISSING,
        actionUrl: '/apps/repositories/github-setup',
      },
    ]);
    expect(linked.title).toBe('Connect your GitHub account');
    expect(setup.title).toBe('Set up GitHub');
  });

  it('asks for a token, never for a GitHub App, where the installation uses tokens', () => {
    const [item] = credentialItems([
      {
        ...base,
        kind: CredentialKind.GITHUB_PAT,
        status: CredentialStatus.MISSING,
        actionUrl: '/apps/repositories',
      },
    ]);
    expect(item.title).toBe('Connect your GitHub account');
    expect(item.detail).not.toMatch(/GitHub App/);
    expect(item.credential).toMatchObject({ kind: 'github_pat' });
  });
});

describe('backupItem', () => {
  it('is absent when nothing alarms', () => {
    expect(backupItem([row({ alarm: false })])).toBeNull();
  });

  it('counts the alarms, databases first, each with a way to protect it', () => {
    const item = backupItem([
      row({ applicationId: 'w', name: 'web' }),
      row({ applicationId: 'd', name: 'pg', kind: 'DATABASE' }),
      row({ applicationId: 'x', name: 'cache' }),
      row({ applicationId: 'q', name: 'quiet', alarm: false }),
    ]);
    expect(item).toMatchObject({
      kind: 'apps_without_backup',
      title: '3 apps with data and no backup',
      detail: 'pg, cache and 1 more',
    });
    expect(item!.applications!.map((a) => a.name)).toEqual([
      'pg',
      'cache',
      'web',
    ]);
    expect(item!.applications![0].protect.path).toBe(
      '/management/backup/policies/new?clusterId=c1&applicationId=d&engineClass=database',
    );
  });

  it('asks for the database engine when the app is a database', () => {
    const item = backupItem([row({ name: 'pg', kind: 'DATABASE' })]);
    expect(item!.applications![0].protect.path).toContain(
      'engineClass=database',
    );
  });

  it('speaks in the singular for one app', () => {
    expect(backupItem([row({ name: 'pg' })])).toMatchObject({
      title: '1 app with data and no backup',
      detail: 'pg',
    });
  });
});

describe('assembleNeedsYou', () => {
  it('puts the urgent first and does not count what asks nothing', () => {
    const result = assembleNeedsYou(
      [
        ...clusterItems([cluster(ClusterStatus.CREATING, 'new')]),
        backupItem([row({})])!,
        ...clusterItems([cluster(ClusterStatus.ERROR, 'bad')]),
      ],
      NOW,
    );
    expect(result.items.map((i) => i.level)).toEqual([
      'critical',
      'warning',
      'info',
    ]);
    expect(result.count).toBe(2);
    expect(result.generatedAt).toBe(NOW.toISOString());
  });
});
