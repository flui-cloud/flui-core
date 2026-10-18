import { createHash } from 'node:crypto';
import {
  TopologyAppStatus,
  TopologyExposure,
  TopologyOverlay,
  TopologyStackType,
} from '../enums/topology.enums';
import { TopologyAppDto, TopologyStackDto } from '../dto/topology.dto';
import {
  GroupableApp,
  installIdOf,
  pickPrimaryComponent,
} from '../../applications/services/application-grouping.core';

export { installIdOf };

export interface AppRecord extends GroupableApp {
  name: string;
  /** Removed in Flui while its workload still runs on the cluster. */
  deletedAt?: Date | null;
  projectId?: string | null;
  sourceConfig?: {
    repositoryId?: string;
    gitUrl?: string;
    repoUrl?: string;
    subPath?: string;
    imageRef?: string;
  } | null;
}

export interface InstallRecord {
  id: string;
  displayName: string;
  resolvedFqdn?: string | null;
}

const STATUS_SEVERITY: TopologyAppStatus[] = [
  TopologyAppStatus.ERROR,
  TopologyAppStatus.WARNING,
  TopologyAppStatus.STOPPED,
  TopologyAppStatus.RUNNING,
];

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function repositoryOf(record: AppRecord): string | undefined {
  const source = record.sourceConfig;
  if (source?.repositoryId) return `id:${source.repositoryId}`;
  const url = source?.gitUrl ?? source?.repoUrl;
  if (!url) return undefined;
  const bare = url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/\.git$/, '');
  return 'url:' + withoutTrailingSlashes(bare);
}

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/**
 * The same app on two clusters: same repository, same folder, same name. A
 * catalog component is its own install's, never shared. A digest, so the key
 * says nothing about the repository it came from.
 */
export function groupKeyOf(record: AppRecord): string {
  if (installIdOf(record)) return `app:${record.id}`;
  const repository = repositoryOf(record);
  if (repository) {
    const subPath = record.sourceConfig?.subPath ?? '';
    return 'repo:' + digest([repository, subPath, record.name].join('|'));
  }
  const image = record.sourceConfig?.imageRef;
  return image
    ? 'image:' + digest([imageRepository(image), record.name].join('|'))
    : 'name:' + digest(record.name);
}

/** The image without its tag or digest: a new release is still the same app. */
export function imageRepository(ref: string): string {
  const untagged = ref.split('@')[0];
  const slash = untagged.lastIndexOf('/');
  const colon = untagged.lastIndexOf(':');
  return colon > slash ? untagged.slice(0, colon) : untagged;
}

export function exposureOf(record: AppRecord | undefined): TopologyExposure {
  const value = record?.exposure as TopologyExposure | undefined;
  return value && Object.values(TopologyExposure).includes(value)
    ? value
    : TopologyExposure.CLUSTER;
}

export function worstStatus(statuses: TopologyAppStatus[]): TopologyAppStatus {
  return (
    STATUS_SEVERITY.find((s) => statuses.includes(s)) ??
    TopologyAppStatus.RUNNING
  );
}

function primaryOf(
  install: InstallRecord,
  apps: TopologyAppDto[],
  records: Map<string, AppRecord>,
): TopologyAppDto {
  const withRecords = apps.map((app) => ({
    app,
    id: app.id,
    slug: records.get(app.id)?.slug ?? '',
    exposure: app.exposure,
  }));
  return (
    pickPrimaryComponent(install.resolvedFqdn, withRecords) ?? withRecords[0]
  ).app;
}

function standaloneStack(app: TopologyAppDto): TopologyStackDto {
  app.stackId = `app:${app.id}`;
  return {
    id: app.stackId,
    clusterId: app.clusterId,
    name: app.displayName,
    type: TopologyStackType.STANDALONE,
    primaryAppId: app.id,
    appIds: [app.id],
    status: app.status,
  };
}

/** A leftover: still using the server, but not an app Flui manages any more. */
function leftoverStack(
  app: TopologyAppDto,
  record: AppRecord,
): TopologyStackDto {
  app.status = TopologyAppStatus.WARNING;
  app.statusReason = 'Removed in Flui, still running on the cluster';
  app.exposure = exposureOf(record);
  app.groupKey = `app:${app.id}`;
  return standaloneStack(app);
}

/** Fills each app's stack, group and exposure, and returns the stacks. */
export function assignStacks(
  apps: TopologyAppDto[],
  records: Map<string, AppRecord>,
  installs: Map<string, InstallRecord>,
): TopologyStackDto[] {
  const composed = new Map<string, TopologyAppDto[]>();
  const stacks: TopologyStackDto[] = [];

  for (const app of apps) {
    const record = records.get(app.id);
    // The name every other page shows, not the workload's suffixed one.
    if (record?.name) app.displayName = record.name;
    app.projectId = record?.projectId ?? null;
    if (record?.deletedAt) {
      stacks.push(leftoverStack(app, record));
      continue;
    }
    app.exposure = exposureOf(record);
    app.groupKey = record ? groupKeyOf(record) : `app:${app.id}`;
    const installId = record ? installIdOf(record) : undefined;
    if (installId && installs.has(installId)) {
      const key = `${app.clusterId}::${installId}`;
      composed.set(key, [...(composed.get(key) ?? []), app]);
      continue;
    }
    stacks.push(standaloneStack(app));
  }

  for (const [key, members] of composed) {
    const installId = key.slice(key.indexOf('::') + 2);
    const install = installs.get(installId)!;
    for (const app of members) app.stackId = installId;
    stacks.push({
      id: installId,
      clusterId: members[0].clusterId,
      name: install.displayName,
      type: TopologyStackType.COMPOSED,
      primaryAppId: primaryOf(install, members, records).id,
      appIds: members.map((a) => a.id),
      status: worstStatus(members.map((a) => a.status)),
    });
  }

  return stacks.sort(
    (a, b) =>
      a.clusterId.localeCompare(b.clusterId) || a.name.localeCompare(b.name),
  );
}

export function overlayOf(input: {
  networkOn: boolean;
  isControl: boolean;
  held: boolean;
  member: boolean;
}): TopologyOverlay {
  if (!input.networkOn) return TopologyOverlay.OFF;
  if (input.isControl) return TopologyOverlay.TUNNEL;
  return input.member && !input.held
    ? TopologyOverlay.TUNNEL
    : TopologyOverlay.PUBLIC_ADDRESS;
}
