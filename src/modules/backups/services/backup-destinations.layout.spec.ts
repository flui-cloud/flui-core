import { ConflictException } from '@nestjs/common';
import { BackupDestinationsService } from './backup-destinations.service';

function build(keysByPrefix: Record<string, string[]>, metadata = {}) {
  const dest = {
    id: 'd1',
    userId: 'u1',
    bucket: 'flui-backups',
    pathPrefix: 'flui/a83dad2e',
    metadata,
    accessKeyEncrypted: 'a',
    secretKeyEncrypted: 's',
  };
  const repo = {
    findById: jest.fn().mockResolvedValue(dest),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const backend = {
    listObjects: jest.fn(async (_c: unknown, prefix: string) => ({
      keys: keysByPrefix[prefix] ?? [],
    })),
  };
  const service = new BackupDestinationsService(
    repo as never,
    { decrypt: (v: string) => v } as never,
    { forProvider: () => backend } as never,
    null as never,
  );
  return { service, repo };
}

describe('BackupDestinationsService.upgradeLayout', () => {
  it('switches a destination with no cluster backups at the top', async () => {
    const { service, repo } = build({ 'pgbackrest/': ['pgbackrest/x'] });
    await expect(service.upgradeLayout('d1', 'u1')).resolves.toMatchObject({
      changed: true,
    });
    expect(repo.update).toHaveBeenCalledWith('d1', {
      metadata: { layout: 'engine-prefixed' },
    });
  });

  it('refuses while cluster backups sit at the top, and says how to move them', async () => {
    const { service, repo } = build({
      'backups/': ['backups/b1/x'],
      'kopia/': ['kopia/y'],
    });
    const err = await service.upgradeLayout('d1', 'u1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(JSON.stringify(err.getResponse())).toContain(
      'rclone move <remote>:flui-backups/flui/a83dad2e/backups <remote>:flui-backups/flui/a83dad2e/velero/backups',
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('switches anyway when forced, naming what was left behind', async () => {
    const { service } = build({ 'backups/': ['backups/b1/x'] });
    await expect(
      service.upgradeLayout('d1', 'u1', true),
    ).resolves.toMatchObject({
      changed: true,
      leftBehind: ['backups'],
    });
  });

  it("does not touch another person's destination", async () => {
    const { service } = build({});
    await expect(service.upgradeLayout('d1', 'someone-else')).rejects.toThrow(
      /not found/,
    );
  });
});
