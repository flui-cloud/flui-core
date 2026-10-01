jest.mock('@kubernetes/client-node', () => ({}));

import { NotFoundException } from '@nestjs/common';
import { AppBackupDecisionService } from './app-backup-decision.service';

function build(app: unknown) {
  const apps = {
    findOne: jest.fn(async () => app),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const protection = { reconcile: jest.fn(async () => null) };
  return {
    apps,
    protection,
    service: new AppBackupDecisionService(apps as never, protection as never),
  };
}

const app = { id: 'a1', slug: 'pg', clusterId: 'c1' };
const user = { userId: 'u1', displayName: 'Dawit' };

describe('AppBackupDecisionService', () => {
  it('stores the decision and lets the protected cluster skip the app now', async () => {
    const { service, apps, protection } = build(app);
    const view = await service.set(
      'a1',
      { notBackedUp: true, note: 'scratch' },
      user,
    );
    expect(view.decision).toMatchObject({
      notBackedUp: true,
      note: 'scratch',
      decidedBy: 'u1',
      decidedByName: 'Dawit',
    });
    expect(apps.update).toHaveBeenCalledWith('a1', {
      backupDecision: view.decision,
    });
    expect(protection.reconcile).toHaveBeenCalledWith('c1', {
      onlyAppIds: ['a1'],
      runFirstBackup: false,
    });
  });

  it('clears it to back the app up again, with a first backup where its cluster is protected', async () => {
    const { service, apps, protection } = build(app);
    const view = await service.set('a1', { notBackedUp: false }, user);
    expect(view).toEqual({ applicationId: 'a1', decision: null });
    expect(apps.update).toHaveBeenCalledWith('a1', { backupDecision: null });
    expect(protection.reconcile).toHaveBeenCalledWith('c1', {
      onlyAppIds: ['a1'],
      runFirstBackup: true,
    });
  });

  it('answers even when the cluster protection cannot be updated at once', async () => {
    const { service, protection } = build(app);
    protection.reconcile.mockRejectedValueOnce(new Error('busy'));
    await expect(
      service.set('a1', { notBackedUp: true }, user),
    ).resolves.toMatchObject({ applicationId: 'a1' });
  });

  it('refuses an application that does not exist', async () => {
    const { service, apps } = build(null);
    await expect(
      service.set('nope', { notBackedUp: true }, user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(apps.update).not.toHaveBeenCalled();
  });
});
