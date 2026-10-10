jest.mock('@kubernetes/client-node', () => ({}));

import { ForbiddenException } from '@nestjs/common';
import { SANDBOX_GUEST_REQUEST } from './sandbox-fence.guard';
import { ApplicationSnapshotsController } from '../../applications/controllers/application-snapshots.controller';
import { DbBackupController } from '../../database-console/controllers/db-backup.controller';

/** F-103: a guest never writes into the platform's storage, by id or by a bucket made for it. */
describe('platform storage and demo guests', () => {
  const guest = {
    user: { userId: 'g' },
    [SANDBOX_GUEST_REQUEST]: { tenancy: 't' },
  } as never;

  it('refuses a volume backup to a destination or to an auto-provisioned bucket', async () => {
    const startForApp = jest.fn();
    const controller = Object.create(
      ApplicationSnapshotsController.prototype,
    ) as ApplicationSnapshotsController;
    Object.assign(controller, { volumeBackupsService: { startForApp } });
    await expect(
      controller.createBackup('app', guest, {
        destinationId: 'operator-bucket',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.createBackup('app', guest, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(startForApp).not.toHaveBeenCalled();
  });

  it('refuses a database dump into a destination but still lets it be downloaded', async () => {
    const dumpToDestination = jest.fn();
    const controller = Object.create(
      DbBackupController.prototype,
    ) as DbBackupController;
    Object.assign(controller, {
      backup: {
        info: jest.fn(async () => ({ supported: true, format: 'sql' })),
        dumpToDestination,
      },
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.dump('db', 'operator-bucket', guest, res as never);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(dumpToDestination).not.toHaveBeenCalled();
  });
});
