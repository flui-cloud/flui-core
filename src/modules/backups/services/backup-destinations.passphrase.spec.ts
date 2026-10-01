import { BackupDestinationsService } from './backup-destinations.service';
import { EncryptionMode } from '../enums/destination-health.enum';

describe('BackupDestinationsService.passphraseFor', () => {
  const encryption = {
    encrypt: (v: string) => `sealed:${v}`,
    decrypt: (v: string) => v.replace(/^sealed:/, ''),
  };
  const build = () => {
    const repo = { update: jest.fn(async () => undefined) };
    const service = new BackupDestinationsService(
      repo as never,
      encryption as never,
      {} as never,
      {} as never,
    );
    return { service, repo };
  };

  it('returns the passphrase a destination already has, and writes nothing', async () => {
    const { service, repo } = build();
    const dest = {
      id: 'd1',
      encryptionMode: EncryptionMode.FLUI_MANAGED,
      encryptionPassphraseEncrypted: 'sealed:kept',
    };
    await expect(service.passphraseFor(dest as never)).resolves.toBe('kept');
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('gives a destination without one a random passphrase, sealed', async () => {
    const { service, repo } = build();
    const dest = { id: 'd2', encryptionMode: EncryptionMode.NONE };

    const passphrase = await service.passphraseFor(dest as never);

    expect(passphrase).toMatch(/^[0-9a-f]{64}$/);
    expect(repo.update).toHaveBeenCalledWith('d2', {
      encryptionMode: EncryptionMode.FLUI_MANAGED,
      encryptionPassphraseEncrypted: `sealed:${passphrase}`,
    });
    await expect(service.passphraseFor(dest as never)).resolves.toBe(
      passphrase,
    );
    expect(repo.update).toHaveBeenCalledTimes(1);
  });
});
