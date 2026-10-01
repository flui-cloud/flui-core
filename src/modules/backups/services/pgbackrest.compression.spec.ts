jest.mock('@kubernetes/client-node', () => ({}));

import { PgBackrestService } from './pgbackrest.service';
import {
  DEFAULT_ARCHIVE_TIMEOUT_SECONDS,
  archiveTimeoutSeconds,
} from './pgbackrest-config.util';

const APP = 'app-1';
const dest = {
  id: 'dest-1',
  endpoint: 'https://s3.example.test',
  bucket: 'bkt',
  region: 'eu',
  pathPrefix: 'pfx/',
  forcePathStyle: true,
  accessKeyEncrypted: 'AK',
  secretKeyEncrypted: 'SK',
} as any;

function scriptOf(cmd: string[]): string {
  const b64 = /echo (\S+) \| base64 -d \| sh/.exec(cmd[2])![1];
  return Buffer.from(b64, 'base64').toString('utf-8');
}

function make(execReply?: (script: string) => string) {
  const scripts: string[] = [];
  const k8s = {
    execInPod: jest.fn(async (...args: any[]) => {
      const script = scriptOf(args[4]);
      scripts.push(script);
      return execReply?.(script) ?? 'yes';
    }),
  };
  const service = new PgBackrestService(
    k8s as any,
    { decrypt: (v: string) => v } as any,
    {
      findOne: jest.fn(async () => ({
        id: APP,
        clusterId: 'c1',
        k8sNamespace: 'ns',
        slug: 'pg',
        env: [],
      })),
    } as any,
    { findOne: jest.fn(async () => ({ kubeconfigEncrypted: 'kc' })) } as any,
    { passphraseFor: jest.fn(async () => 'pass') } as any,
    { retire: jest.fn() } as any,
  );
  return { service, scripts };
}

function confOf(scripts: string[]): string {
  const enable = scripts.find((s) => s.includes('stanza-create'))!;
  const b64 = /echo (\S+) \| base64 -d >/.exec(enable)![1];
  return Buffer.from(b64, 'base64').toString('utf-8');
}

describe('pgBackRest repository size', () => {
  it('writes block incremental and zstd into the repository configuration', async () => {
    const { service, scripts } = make();
    await service.enable(APP, dest);

    const global = confOf(scripts).split('[main]')[0];
    expect(global).toContain('repo1-bundle=y\n');
    expect(global).toContain('repo1-block=y\n');
    expect(global).toContain('compress-type=zst\n');
    expect(global).toContain('compress-level=3\n');
    // WAL older than the oldest retained full goes with it.
    expect(global).toContain('repo1-retention-archive-type=full\n');
    expect(global).not.toContain('repo1-retention-archive=');
  });

  it('ships a quiet database every five minutes by default', async () => {
    const { service, scripts } = make();
    await service.enable(APP, dest);

    const enable = scripts.find((s) => s.includes('stanza-create'))!;
    expect(DEFAULT_ARCHIVE_TIMEOUT_SECONDS).toBe(300);
    expect(enable).toContain("ALTER SYSTEM SET archive_timeout = '300s';");
  });

  it('honours a policy that asks for another interval, within bounds', async () => {
    const { service, scripts } = make();
    await service.enable(APP, dest, { archiveTimeoutSeconds: 120 });
    expect(scripts.find((s) => s.includes('stanza-create'))).toContain(
      "archive_timeout = '120s'",
    );

    expect(archiveTimeoutSeconds(5)).toBe(60);
    expect(archiveTimeoutSeconds(100_000)).toBe(3600);
    expect(archiveTimeoutSeconds(Number.NaN)).toBe(300);
    expect(archiveTimeoutSeconds()).toBe(300);
  });
});

describe('pgBackRest compression recorded on the artifact', () => {
  const info = (label: string, repository: Record<string, number>) =>
    JSON.stringify([
      {
        name: 'main',
        cipher: 'aes-256-cbc',
        backup: [
          { label: '20260901-010000F', type: 'full', info: { repository: {} } },
          { label, type: 'incr', info: { repository } },
        ],
      },
    ]);

  it('reads the algorithm and block maps back from the newest backup', async () => {
    const { service, scripts } = make((script) => {
      if (script.includes('info --output=json')) {
        return info('20260901-010000F_20260902-010000I', {
          delta: 10,
          'size-map': 4,
        });
      }
      if (script.includes('repo-get')) {
        return 'option-compress-level=3\noption-compress-type="zst"\n';
      }
      return '17.2';
    });

    const facts = await service.describeForArtifact(APP);

    expect(facts.compression).toEqual({
      type: 'zstd',
      level: 3,
      blockIncremental: true,
    });
    expect(facts.repository?.cipher).toBe('aes-256-cbc');
    expect(scripts.find((s) => s.includes('repo-get'))).toContain(
      'repo-get backup/main/20260901-010000F_20260902-010000I/backup.manifest',
    );
  });

  it('reports a backup written before the change as gzip without block maps', async () => {
    const { service } = make((script) => {
      if (script.includes('info --output=json')) {
        return info('20260901-010000F_20260902-010000I', { delta: 10 });
      }
      if (script.includes('repo-get')) {
        return 'option-compress-level=6\noption-compress-type="gz"\n';
      }
      return '';
    });

    expect((await service.describeForArtifact(APP)).compression).toEqual({
      type: 'gzip',
      level: 6,
      blockIncremental: false,
    });
  });

  it('claims nothing when the manifest cannot be read', async () => {
    const { service } = make((script) => {
      if (script.includes('info --output=json')) {
        return info('20260901-010000F_20260902-010000I', { 'size-map': 1 });
      }
      if (script.includes('repo-get')) throw new Error('boom');
      return '';
    });

    expect(
      (await service.describeForArtifact(APP)).compression,
    ).toBeUndefined();
  });

  it('never puts an unexpected label into a shell command', async () => {
    const { service, scripts } = make((script) =>
      script.includes('info --output=json')
        ? info('x; rm -rf /', { 'size-map': 1 })
        : '',
    );

    expect(
      (await service.describeForArtifact(APP)).compression,
    ).toBeUndefined();
    expect(scripts.some((s) => s.includes('repo-get'))).toBe(false);
  });
});
