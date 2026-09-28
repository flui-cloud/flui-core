import { ClusterStatus } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  CredentialKind,
  CredentialStatus,
  CredentialsStatusItemDto,
} from '../../repositories/dto/ghcr-pat.dto';
import { ApplicationKind } from '../../applications/enums/application-kind.enum';
import type { AppCoverageRow } from '../../backups/services/app-coverage.service';
import { protectPath } from '../../backups/utils/app-coverage.rules';

export type NeedsYouKind =
  | 'cluster_broken'
  | 'cluster_operation'
  | 'credential'
  | 'apps_without_backup';

export type NeedsYouLevel = 'critical' | 'warning' | 'info';

export interface NeedsYouAction {
  label: string;
  path: string;
}

export interface NeedsYouApp {
  applicationId: string;
  name: string;
  kind: string;
  clusterId: string;
  clusterName: string | null;
  reason: string;
  lastSuccessAt: string | null;
  protect: NeedsYouAction;
}

export interface NeedsYouItem {
  id: string;
  kind: NeedsYouKind;
  level: NeedsYouLevel;
  title: string;
  detail: string;
  action: NeedsYouAction | null;
  cluster?: { id: string; name: string; provider: string; status: string };
  credential?: { kind: string; status: string; expiresAt: string | null };
  applications?: NeedsYouApp[];
}

export interface NeedsYou {
  generatedAt: string;
  /** Items that ask for something; an operation in progress is shown but asks nothing. */
  count: number;
  items: NeedsYouItem[];
}

export interface NeedsYouCluster {
  id: string;
  name: string;
  provider: string;
  status: string;
}

const clusterPath = (id: string) => `/cluster/${id}/overview`;

const BROKEN: Partial<
  Record<string, { level: NeedsYouLevel; title: string; detail: string }>
> = {
  [ClusterStatus.ERROR]: {
    level: 'critical',
    title: '{name} is in error',
    detail: 'Open the cluster to see what failed',
  },
  [ClusterStatus.LOST]: {
    level: 'critical',
    title: '{name} is lost',
    detail:
      'It is not coming back; its applications can be rebuilt on another cluster',
  },
  [ClusterStatus.DELETION_FAILED]: {
    level: 'warning',
    title: 'Removing {name} did not finish',
    detail: 'Open the cluster to see what is left',
  },
};

const IN_PROGRESS: Partial<Record<string, { title: string; detail: string }>> =
  {
    [ClusterStatus.CREATING]: {
      title: '{name} is being created',
      detail: 'Provisioning cluster · nothing to do',
    },
    [ClusterStatus.SCALING]: {
      title: '{name} is changing size',
      detail: 'Nodes are being added or removed · nothing to do',
    },
    [ClusterStatus.DELETING]: {
      title: '{name} is being removed',
      detail: 'Removing cluster · nothing to do',
    },
  };

export function clusterItems(clusters: NeedsYouCluster[]): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const c of clusters) {
    const cluster = {
      id: c.id,
      name: c.name,
      provider: c.provider,
      status: c.status,
    };
    const broken = BROKEN[c.status];
    if (broken) {
      items.push({
        id: `cluster:${c.id}`,
        kind: 'cluster_broken',
        level: broken.level,
        title: broken.title.replace('{name}', c.name),
        detail: broken.detail,
        action: { label: 'Open cluster', path: clusterPath(c.id) },
        cluster,
      });
      continue;
    }
    const running = IN_PROGRESS[c.status];
    if (running) {
      items.push({
        id: `cluster:${c.id}`,
        kind: 'cluster_operation',
        level: 'info',
        title: running.title.replace('{name}', c.name),
        detail: running.detail,
        action: null,
        cluster,
      });
    }
  }
  return items;
}

function inDays(days: number | null): string {
  if (days == null) return 'Replace it before it stops working';
  return `In ${days} day${days === 1 ? '' : 's'}`;
}

const GITHUB_SETUP_PATH = '/apps/repositories/github-setup';

function credentialText(item: CredentialsStatusItemDto): {
  title: string;
  detail: string;
} {
  const label = item.label;
  switch (item.status) {
    case CredentialStatus.MISSING:
      if (item.kind === CredentialKind.GITHUB_APP) {
        return item.actionUrl === GITHUB_SETUP_PATH
          ? {
              title: 'Set up GitHub',
              detail: 'No GitHub App is configured for this installation yet',
            }
          : {
              title: 'Connect your GitHub account',
              detail:
                'The GitHub App is set up; your account is not linked yet',
            };
      }
      return {
        title: `${label} not configured`,
        detail: 'Nothing is saved for it yet',
      };
    case CredentialStatus.EXPIRED:
      return {
        title: `${label} has expired`,
        detail: 'Replace it to keep using it',
      };
    case CredentialStatus.INVALID:
      return {
        title: `${label} is not accepted`,
        detail: 'The last check was refused; replace it',
      };
    case CredentialStatus.EXPIRING_SOON:
      return {
        title: `${label} expires soon`,
        detail: inDays(item.daysUntilExpiry),
      };
    case CredentialStatus.UNKNOWN_EXPIRY:
      return {
        title: `${label} has no known expiry`,
        detail: 'Flui cannot tell when it stops working',
      };
    default:
      return { title: label, detail: '' };
  }
}

const CREDENTIAL_LEVEL: Partial<Record<CredentialStatus, NeedsYouLevel>> = {
  [CredentialStatus.EXPIRED]: 'critical',
  [CredentialStatus.INVALID]: 'critical',
  [CredentialStatus.EXPIRING_SOON]: 'warning',
  [CredentialStatus.MISSING]: 'warning',
  [CredentialStatus.UNKNOWN_EXPIRY]: 'info',
};

/** The same items the credentials banner raises: everything that is not valid. */
export function credentialItems(
  items: CredentialsStatusItemDto[],
): NeedsYouItem[] {
  return items
    .filter((i) => i.status !== CredentialStatus.VALID)
    .map((i) => {
      const text = credentialText(i);
      return {
        id: `credential:${i.kind.toLowerCase()}${i.providerId ? ':' + i.providerId : ''}`,
        kind: 'credential' as const,
        level: CREDENTIAL_LEVEL[i.status] ?? 'warning',
        ...text,
        action: i.actionUrl ? { label: 'Manage', path: i.actionUrl } : null,
        credential: {
          kind: i.kind.toLowerCase(),
          status: i.status.toLowerCase(),
          expiresAt: i.expiresAt ? new Date(i.expiresAt).toISOString() : null,
        },
      };
    });
}

export function backupItem(rows: AppCoverageRow[]): NeedsYouItem | null {
  const alarms = rows
    .filter((r) => r.alarm)
    .sort(
      (a, b) =>
        Number(b.kind === ApplicationKind.DATABASE) -
          Number(a.kind === ApplicationKind.DATABASE) ||
        a.name.localeCompare(b.name),
    );
  if (alarms.length === 0) return null;
  const n = alarms.length;
  const names = alarms.slice(0, 2).map((r) => r.name);
  const rest = n - names.length;
  return {
    id: 'backup:apps-without-backup',
    kind: 'apps_without_backup',
    level: 'warning',
    title: `${n} app${n === 1 ? '' : 's'} with data and no backup`,
    detail:
      rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', '),
    action: { label: 'Open backups', path: '/management/backup' },
    applications: alarms.map((r) => ({
      applicationId: r.applicationId,
      name: r.name,
      kind: r.kind,
      clusterId: r.clusterId,
      clusterName: r.clusterName,
      reason: r.reason,
      lastSuccessAt: r.lastSuccessAt,
      protect: { label: 'Protect', path: protectPath(r) },
    })),
  };
}

const LEVEL_RANK: Record<NeedsYouLevel, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function assembleNeedsYou(parts: NeedsYouItem[], now: Date): NeedsYou {
  const items = [...parts].sort(
    (a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level],
  );
  return {
    generatedAt: now.toISOString(),
    count: items.filter((i) => i.level !== 'info' || i.action !== null).length,
    items,
  };
}
