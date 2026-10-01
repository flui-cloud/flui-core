jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { ContinuousBackupEngineRegistry } from './continuous-backup-engine.registry';
import {
  DumpFamily,
  dumpLabel,
  dumpLabelToIso,
  dumpObjectKey,
  dumpScript,
  loadScript,
  renderDumpJob,
} from './logical-dump.util';

const engine = (name: string, tooling: () => Promise<void>) =>
  ({ engine: name, requireTooling: jest.fn(tooling) }) as any;

describe('choosing the engine that protects a database', () => {
  const refuse = (msg: string) => async () => {
    throw new BadRequestException(msg);
  };
  const ok = async () => undefined;

  const registry = (pg: any, pgDump: any) =>
    new ContinuousBackupEngineRegistry(
      pg,
      engine('mariadb', ok),
      pgDump,
      engine('mariadb-dump', ok),
    );

  it('keeps continuous backup when the image can ship its log', async () => {
    const pg = engine('postgres', ok);
    const chosen = await registry(pg, engine('postgres-dump', ok)).chooseFor(
      'postgres',
      'app-1',
    );
    expect(chosen.engine).toBe('postgres');
  });

  it('falls back to scheduled dumps for a vendor image, as bundles run', async () => {
    const pg = engine('postgres', refuse('its image does not ship pgBackRest'));
    const chosen = await registry(pg, engine('postgres-dump', ok)).chooseFor(
      'postgres',
      'app-1',
    );
    expect(chosen.engine).toBe('postgres-dump');
  });

  it('keeps the continuous refusal when a dump cannot run either', async () => {
    const pg = engine('postgres', refuse('This database is not running'));
    const dump = engine('postgres-dump', refuse('not running'));
    await expect(
      registry(pg, dump).chooseFor('postgres', 'app-1'),
    ).rejects.toThrow('This database is not running');
  });
});

describe('logical dump layout and job', () => {
  it('names dumps by a sortable instant under their own folder', () => {
    const label = dumpLabel(new Date('2026-09-27T13:45:00.123Z'));
    expect(label).toBe('20260927T134500Z');
    expect(dumpLabelToIso(label)).toBe('2026-09-27T13:45:00Z');
    expect(dumpObjectKey('app-1', label, DumpFamily.POSTGRES)).toBe(
      'dumps/app-1/20260927T134500Z/dump.pgdump',
    );
    expect(dumpObjectKey('app-1', label, DumpFamily.MARIADB)).toBe(
      'dumps/app-1/20260927T134500Z/dump.sql.gz',
    );
  });

  it('fails the pipeline when the dump fails, not only when the upload does', () => {
    for (const family of [DumpFamily.POSTGRES, DumpFamily.MARIADB]) {
      expect(dumpScript(family)).toMatch(/^set -euo pipefail/);
      expect(loadScript(family)).toMatch(/^set -euo pipefail/);
    }
    expect(loadScript(DumpFamily.POSTGRES)).toContain('--exit-on-error');
    expect(dumpScript(DumpFamily.POSTGRES)).not.toContain('\\$');
  });

  it('loads a Postgres dump so a second attempt replaces the first instead of failing or mixing', () => {
    // Measured against postgres:16 with the same flags: a load retried after it
    // succeeded ends with the rows once; a load cut off halfway leaves nothing
    // behind; tables an application created first are replaced; an object the
    // dump does not own that depends on one it drops fails the whole load and
    // leaves the database as it was.
    const script = loadScript(DumpFamily.POSTGRES);
    expect(script).toContain('--clean --if-exists');
    expect(script).toContain('--single-transaction');
    expect(script).not.toContain('CASCADE');
  });

  it("runs from the database's image with its env, never as one of its pods", () => {
    const job: any = renderDumpJob({
      jobName: 'flui-dump-x',
      namespace: 'ns',
      appId: 'app-1',
      image: 'postgres:15-alpine',
      rcloneImage: 'rclone/rclone:1.68',
      secretName: 'flui-dump-x-s3',
      script: 'true',
      env: [{ name: 'POSTGRES_USER', valueFrom: { configMapKeyRef: {} } }],
      envFrom: [],
      imagePullSecrets: [],
      tolerations: [],
      timeoutSeconds: 60,
    });
    const pod = job.spec.template;
    expect(pod.metadata.labels['flui-app-id']).toBeUndefined();
    expect(job.metadata.labels['flui-app-id']).toBeUndefined();
    const main = pod.spec.containers[0];
    expect(main.image).toBe('postgres:15-alpine');
    expect(main.env[0].name).toBe('POSTGRES_USER');
    expect(main.envFrom).toContainEqual({
      secretRef: { name: 'flui-dump-x-s3' },
    });
    expect(job.spec.backoffLimit).toBe(0);
  });
});
