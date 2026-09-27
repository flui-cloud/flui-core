import { DestinationHealthStatus } from '../enums/destination-health.enum';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { StorageLocationUnavailableError } from '../services/velero-client.service';

/** Record why the destination cannot be used, then fail with the same words. */
export async function markDestinationUnusable(
  destinations: Pick<BackupDestinationRepository, 'update'>,
  destinationId: string,
  err: unknown,
): Promise<never> {
  if (err instanceof StorageLocationUnavailableError) {
    await destinations.update(destinationId, {
      healthStatus: DestinationHealthStatus.FAILED,
      lastHealthError: err.message,
      lastHealthCheckAt: new Date(),
    });
  }
  throw err;
}
