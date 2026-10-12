import { BadRequestException } from '@nestjs/common';
import { AppMigrationEntity } from '../entities/app-migration.entity';
import { AppMigrationStatus } from '../enums/app-migration.enum';
import { MigrationBridgeView } from './bridge-view';

export function assertNotOrchestrated(
  mig: AppMigrationEntity,
  fromOrchestrator: boolean,
): void {
  if (mig.fullMigrationId && !fromOrchestrator) {
    throw new BadRequestException(
      `Migration ${mig.id} is a leg of full-migration ${mig.fullMigrationId} — drive it through the full-migration, not directly`,
    );
  }
}

export function canResumeCutover(
  mig: AppMigrationEntity,
  liveJobs?: Set<string>,
): boolean {
  if (mig.fullMigrationId) return false;
  if (
    mig.status === AppMigrationStatus.FAILED &&
    mig.bridgeState?.state === 'active'
  ) {
    return true;
  }
  return (
    mig.status === AppMigrationStatus.CUTOVER &&
    !!liveJobs &&
    !liveJobs.has(mig.id)
  );
}

export function bridgeStillNeeded(view: MigrationBridgeView | null): string {
  if (view?.blockedBy === 'ttl') {
    return `The bridge still forwards: DNS answers cached before the switch may point at the old cluster until ${view.closableAt} (twice the record's ${
      view.recordTtlSeconds ?? 300
    } s TTL). Retry after that, or pass closeBridge to close it now.`;
  }
  return 'The DNS switch has not completed, so clients may still reach the old cluster. Resume the cutover first, or pass closeBridge to close the bridge anyway.';
}
