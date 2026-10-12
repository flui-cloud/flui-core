import { ApplicationEntity } from '../../applications/entities/application.entity';
import { AppMigrationEntity } from '../entities/app-migration.entity';
import { VolumeTransferPlan } from '../services/app-volume-transfer.service';

export function volumePlan(
  mig: AppMigrationEntity,
): VolumeTransferPlan | undefined {
  const destinationId = mig.provisionOverrides?.volumeDestinationId;
  return destinationId
    ? {
        destinationId,
        dedicatedNodeName: mig.provisionOverrides?.dedicatedNodeName,
      }
    : undefined;
}

/**
 * The app moves to the destination; a full migration also hands it the
 * rewired database env in the same save, so no moment exists where the app
 * row names the source cluster with the destination's database.
 */
export function bindToTarget(
  mig: AppMigrationEntity,
  app: ApplicationEntity,
): void {
  app.clusterId = mig.targetClusterId;
  const plan = volumePlan(mig);
  if (plan?.dedicatedNodeName) app.dedicatedNodeName = plan.dedicatedNodeName;
  if (mig.fullMigrationId && mig.provisionOverrides?.env) {
    app.env = mig.provisionOverrides.env;
  }
}
