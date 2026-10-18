import { Logger } from '@nestjs/common';
import {
  TopologyAppCategory,
  TopologyAppKind,
  TopologyAppStatus,
} from '../enums/topology.enums';
import { TopologyAppDto } from '../dto/topology.dto';

const logger = new Logger('TopologyValidation');

const VALID_CATEGORIES = new Set<string>(Object.values(TopologyAppCategory));
const VALID_STATUSES = new Set<string>(Object.values(TopologyAppStatus));

export function validateAndFilterApps(
  apps: TopologyAppDto[],
  serverIds: Set<string>,
  clusterId: string,
): TopologyAppDto[] {
  const valid: TopologyAppDto[] = [];

  for (const app of apps) {
    if (!serverIds.has(app.primaryServerId)) {
      logger.warn(
        `[${clusterId}] dropping app ${app.id} (${app.name}): primaryServerId ${app.primaryServerId} not in cluster servers`,
      );
      continue;
    }
    const badReplica = app.replicas.find((r) => !serverIds.has(r.serverId));
    if (badReplica) {
      logger.warn(
        `[${clusterId}] dropping app ${app.id} (${app.name}): replica serverId ${badReplica.serverId} not in cluster servers`,
      );
      continue;
    }
    const replicaSum = app.replicas.reduce((s, r) => s + r.count, 0);
    if (replicaSum !== app.replicaCount) {
      logger.warn(
        `[${clusterId}] dropping app ${app.id} (${app.name}): replicaCount ${app.replicaCount} != sum(replicas) ${replicaSum}`,
      );
      continue;
    }
    if (!app.slug || app.slug.length > 16) {
      logger.warn(
        `[${clusterId}] dropping app ${app.id} (${app.name}): invalid slug "${app.slug}"`,
      );
      continue;
    }

    if (!VALID_CATEGORIES.has(app.category)) {
      app.category = TopologyAppCategory.WEB;
    }
    if (
      app.kind !== TopologyAppKind.USER &&
      app.kind !== TopologyAppKind.SYSTEM
    ) {
      app.kind = TopologyAppKind.USER;
    }
    if (!VALID_STATUSES.has(app.status)) {
      app.status = TopologyAppStatus.RUNNING;
    }

    valid.push(app);
  }

  return valid;
}

export function validateApps(
  apps: TopologyAppDto[],
  serverIds: Set<string>,
  clusterId: string,
): { apps: TopologyAppDto[]; dropped: number } {
  const valid = validateAndFilterApps(apps, serverIds, clusterId);
  return { apps: valid, dropped: apps.length - valid.length };
}
