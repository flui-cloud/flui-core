jest.mock('@kubernetes/client-node', () => ({}));

import { BadRequestException } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { PlatformBackupService } from './platform-backup.service';
import { openPlatformDump } from '../../../../cli/src/lib/platform-dump';

const TRAILER = '-- PostgreSQL database cluster dump complete\n';
const DUMP = `CREATE TABLE secrets (v text);\nINSERT INTO secrets VALUES ('plain-row');\n${TRAILER}`;

function harness(opts: { dump?: string; sameProvider?: boolean } = {}) {
  const uploads: Array<{ key: string; bytes: Buffer }> = [];
  const order: string[] = [];
  let dekSeen: Buffer | undefined;
  const svc = new PlatformBackupService(
    { get: (_k: string, d?: string) => d } as never,
    {
      getControlCluster: async () => ({ id: 'env-1', provider: 'hetzner' }),
    } as never,
    { getKubeconfig: async () => 'kubeconfig' } as never,
    {
      execInPod: async (
        _k: string,
        _n: string,
        _s: string,
        _c: unknown,
        cmd: string[],
      ) =>
        cmd.join(' ').includes('printenv') ? 'pg-pass\n' : 'flui\nzitadel\n',
      execStream: async (
        _k: string,
        _n: string,
        _s: string,
        cmd: string[],
        io: { stdout: NodeJS.WritableStream },
      ) => {
        order.push(`exec:${cmd.join(' ')}`);
        io.stdout.write(Buffer.from(opts.dump ?? DUMP));
      },
    } as never,
    { toCredentials: () => ({}) } as never,
    {
      assertOffProviderStrict: async () => {
        if (opts.sameProvider) throw new BadRequestException('same provider');
      },
    } as never,
    {
      forProvider: () => ({
        uploadFile: async (_c: unknown, key: string, file: string) => {
          order.push(`upload:${key.split('/').slice(-2).join('/')}`);
          uploads.push({ key, bytes: await fs.readFile(file) });
        },
      }),
    } as never,
    {
      assemble: async (input: { dek: Buffer }) => {
        dekSeen = input.dek;
        return {
          ageBytes: Buffer.from('age-sealed'),
          insecureDefaults: [],
          encryptionKeyFingerprint: 'fp',
        };
      },
    } as never,
  );
  const policy = {
    metadata: { platform: { recipient: 'age1operator' } },
  } as never;
  const dest = {
    id: 'd1',
    name: 'offsite',
    provider: 'scaleway_object_storage',
  } as never;
  return { svc, policy, dest, uploads, order, dek: () => dekSeen! };
}

const decrypt = openPlatformDump;

describe('PlatformBackupService', () => {
  it('refuses a policy with no operator age recipient', async () => {
    const h = harness();
    await expect(
      h.svc.execute({ metadata: {} } as never, h.dest),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a destination on the same provider as the master', async () => {
    const h = harness({ sameProvider: true });
    await expect(h.svc.execute(h.policy, h.dest)).rejects.toThrow(
      'same provider',
    );
    expect(h.uploads).toHaveLength(0);
  });

  it('dumps without role passwords, and uploads the sealed keys before the dump', async () => {
    const h = harness();
    await h.svc.execute(h.policy, h.dest);
    expect(h.order[0]).toContain('--no-role-passwords');
    expect(h.order.slice(1)).toEqual([
      'upload:keys/keybundle.age',
      'upload:db/flui-pg.dump.gz.enc',
    ]);
  });

  it('writes only ciphertext, which the CLI restore opens with the key from the bundle', async () => {
    const h = harness();
    const result = await h.svc.execute(h.policy, h.dest);
    const db = h.uploads.find((u) => u.key === result.dbObjectKey)!.bytes;
    expect(db.includes(Buffer.from('plain-row'))).toBe(false);
    expect(decrypt(db, h.dek()).toString()).toBe(DUMP);
  });

  it('refuses to store a dump cut short before the cluster trailer', async () => {
    const h = harness({ dump: 'CREATE TABLE half' });
    await expect(h.svc.execute(h.policy, h.dest)).rejects.toThrow(/trailer/);
    expect(h.uploads.map((u) => u.key)).not.toContainEqual(
      expect.stringContaining('/db/'),
    );
  });

  it('refuses an empty dump', async () => {
    const h = harness({ dump: '' });
    await expect(h.svc.execute(h.policy, h.dest)).rejects.toThrow(/empty/);
  });
});
