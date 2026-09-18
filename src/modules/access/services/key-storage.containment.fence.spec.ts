import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ConfigService } from '@nestjs/config';
import { KeyStorageService } from './key-storage.service';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateSSHKeyDto } from '../dto/create-ssh-key.dto';

/**
 * F-016 of the September 2026 register, confirmed live: the `userName` field of
 * a created SSH key became a directory name under the keys root with nothing in
 * between, so `../../../etc` wrote sealed key material outside it.
 *
 * Asserted at both layers on purpose. The field validator is the good error
 * message; the containment check is the one that holds for a caller that does
 * not exist yet.
 */

const A_REAL_KEY =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('where a private key is allowed to land', () => {
  let root: string;
  let service: KeyStorageService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flui-keys-'));
    const config = {
      get: (name: string, fallback?: string) => {
        if (name === 'SSH_KEYS_PATH') return root;
        if (name === 'SSH_KEY_ENCRYPTION_KEY') return A_REAL_KEY;
        return fallback;
      },
    } as unknown as ConfigService;
    service = new KeyStorageService(config);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps an ordinary name inside the keys root', async () => {
    const written = await service.storePrivateKey('john.doe', '123', 'secret');

    expect(written.startsWith(path.resolve(root) + path.sep)).toBe(true);
    await expect(fs.readFile(written)).resolves.toBeDefined();
  });

  it.each([
    ['../../../etc', 'a climb out of the root'],
    ['..', 'the parent itself'],
    ['a/../../b', 'a climb hidden mid-path'],
    ['/etc', 'an absolute path'],
  ])('refuses %s (%s) and writes nothing', async (userName) => {
    await expect(
      service.storePrivateKey(userName, '123', 'secret'),
    ).rejects.toThrow(/outside the keys directory/);

    // Not merely refused — nothing was created on the way to refusing.
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  describe('a path read back from the database', () => {
    it('is refused for deletion when it points outside the keys root', async () => {
      // Rows written before containment existed are still in the table, and a
      // row is a weaker guarantee than a check.
      const outside = path.join(path.dirname(root), 'planted', 'private.key');

      await expect(service.deleteKey(outside)).rejects.toThrow(
        /stored path is outside/,
      );
      await expect(service.retrievePrivateKey(outside)).rejects.toThrow(
        /stored path is outside/,
      );
    });

    it('does not let the cleanup walk climb past the keys root', async () => {
      const written = await service.storePrivateKey('john.doe', '123', 's');

      await service.deleteKey(written);

      // The key's own directories are gone; the root itself is still standing.
      await expect(fs.readdir(root)).resolves.toEqual([]);
      await expect(fs.stat(root)).resolves.toBeDefined();
    });
  });

  describe('the field that feeds it', () => {
    const dtoFor = (userName: string) =>
      plainToInstance(CreateSSHKeyDto, {
        name: 'k',
        userName,
        type: 'ed25519',
      });

    it('accepts a plain user name', async () => {
      const errors = await validate(dtoFor('john.doe'));
      expect(errors.find((e) => e.property === 'userName')).toBeUndefined();
    });

    it.each(['../../../etc', '..', '.', 'a/b', 'a\\b', 'a b', 'a$(id)', ''])(
      'refuses %p',
      async (userName) => {
        const errors = await validate(dtoFor(userName));
        expect(errors.find((e) => e.property === 'userName')).toBeDefined();
      },
    );
  });
});
