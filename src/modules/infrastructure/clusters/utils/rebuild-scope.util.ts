import {
  ClusterEntity,
  ClusterStatus,
  isControlClusterType,
} from '../entities/cluster.entity';
import { ApplicationEntity } from '../../../applications/entities/application.entity';
import { ApplicationStatus } from '../../../applications/enums/application-status.enum';
import { ApplicationKind } from '../../../applications/enums/application-kind.enum';
import { isPlatformOwned } from '../../../applications/constants/app-provenance';

export function isControl(cluster: ClusterEntity): boolean {
  return isControlClusterType(cluster.clusterType);
}

/** Somebody said it is gone: the restore's retire step, a delete, or a rebuild. */
export function isRetired(cluster: ClusterEntity): boolean {
  return (
    !!cluster.deletedAt ||
    cluster.status === ClusterStatus.DELETED ||
    cluster.status === ClusterStatus.LOST
  );
}

export function isPlatformComponent(app: ApplicationEntity): boolean {
  return isPlatformOwned(app) || app.kind === ApplicationKind.SYSTEM;
}

export function isDeletedApp(app: ApplicationEntity): boolean {
  return !!app.deletedAt || app.status === ApplicationStatus.DELETED;
}

export function isRebuildable(app: ApplicationEntity): boolean {
  return !isPlatformComponent(app) && !isDeletedApp(app);
}

export function parseCpuMillis(value?: string): number {
  if (!value) return 0;
  return value.endsWith('m')
    ? Number.parseInt(value, 10)
    : Math.round(Number.parseFloat(value) * 1000);
}

export function parseMemoryMi(value?: string): number {
  if (!value) return 0;
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti)?$/.exec(value.trim());
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  switch (m[2]) {
    case 'Ki':
      return Math.round(n / 1024);
    case 'Gi':
      return Math.round(n * 1024);
    case 'Ti':
      return Math.round(n * 1024 * 1024);
    default:
      return Math.round(n);
  }
}
