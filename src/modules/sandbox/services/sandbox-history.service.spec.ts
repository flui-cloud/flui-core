// The copy reaches the database console, whose import graph pulls in several
// ESM-only packages ts-jest cannot transform. Every call here is stubbed, so
// none of them is ever constructed.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { SandboxHistoryService } from './sandbox-history.service';
import { SandboxTenantEntity } from '../entities/sandbox-tenant.entity';
import { loadSandboxConfig } from '../sandbox.config';

const config = loadSandboxConfig({
  SANDBOX_ENABLED: 'true',
} as NodeJS.ProcessEnv);

const tenant = {
  id: 't1',
  clusterId: 'c1',
  namespace: 'user-guest-abc',
  userId: 'guest-user',
} as SandboxTenantEntity;

const dumpsOnDisk = (): string[] =>
  readdirSync(tmpdir())
    .filter((name) => name.startsWith('flui-sandbox-history-'))
    .sort();

const postgres = (id: string, namespace: string) => ({
  id,
  clusterId: 'c1',
  k8sNamespace: namespace,
  imageRef: 'postgres:16-alpine',
  labels: {},
  userId: `${id}-owner`,
});

const build = (
  rows: ReturnType<typeof postgres>[],
  behaviour: { dumpFails?: boolean; restoreFails?: boolean } = {},
) => {
  const moved: { from?: string; to?: string; bytes?: number } = {};
  const backups = {
    // Writes to the stream it is handed, like the real one: the service moves
    // the dump through a file, and a stub that wrote nothing would leave that
    // path untested and the file missing.
    dump: async ({ dbInstallId }: { dbInstallId: string }, out: Writable) => {
      if (behaviour.dumpFails) throw new Error('pg_dump refused');
      moved.from = dbInstallId;
      await new Promise<void>((resolve, reject) => {
        out.on('finish', resolve);
        out.on('error', reject);
        out.end('-- pretend this is a database\n');
      });
    },
    restore: async (
      { dbInstallId }: { dbInstallId: string },
      body: Readable,
    ) => {
      if (behaviour.restoreFails) throw new Error('psql refused');
      moved.to = dbInstallId;
      moved.bytes = 0;
      for await (const chunk of body) moved.bytes += (chunk as Buffer).length;
    },
  };
  const applications = {
    find: async ({
      where,
    }: {
      where: { clusterId: string; k8sNamespace: string };
    }) => rows.filter((r) => r.k8sNamespace === where.k8sNamespace),
  };
  const service = new SandboxHistoryService(
    backups as never,
    applications as never,
    config,
  );
  return { service, moved };
};

describe('giving a new tenancy a past', () => {
  it('copies the reference database into the tenancy', async () => {
    const { service, moved } = build([
      postgres('reference-db', 'flui-sandbox-reference'),
      postgres('guest-db', 'user-guest-abc'),
    ]);

    const outcome = await service.copyInto(tenant);

    expect(outcome.copied).toBe(true);
    expect(moved.from).toBe('reference-db');
    expect(moved.to).toBe('guest-db');
    // The dump really reached the restore rather than both ends succeeding at
    // moving nothing.
    expect(moved.bytes).toBeGreaterThan(0);
  });

  /**
   * Every build makes one of these. A dump left behind is a copy of a database
   * sitting in a temp directory, and one per tenancy adds up.
   *
   * The failing variants are also the regression test for something worse: a
   * stream abandoned before its descriptor finished opening used to emit an
   * unhandled `error`, and an unhandled `error` on a stream ends the process.
   */
  it.each([
    ['a copy that worked', {}],
    ['a dump that failed', { dumpFails: true }],
    ['a restore that failed', { restoreFails: true }],
  ])('leaves nothing behind on disk after %s', async (_label, behaviour) => {
    const before = dumpsOnDisk();
    const { service } = build(
      [
        postgres('reference-db', 'flui-sandbox-reference'),
        postgres('guest-db', 'user-guest-abc'),
      ],
      behaviour,
    );

    await service.copyInto(tenant);

    expect(dumpsOnDisk()).toEqual(before);
  });

  /**
   * The invariant, expressed as a test because it is the one thing here that
   * must never be true by accident: the source is the reference namespace and
   * nothing else. Another guest's rows appearing in this guest's area is the
   * exact shape of the failure the fence exists to prevent, and it would be no
   * less a breach for the rows being machine-generated.
   */
  it('never takes another tenancy as the source, even when one is at hand', async () => {
    const { service, moved } = build([
      postgres('other-guest-db', 'user-guest-zzz'),
      postgres('guest-db', 'user-guest-abc'),
    ]);

    const outcome = await service.copyInto(tenant);

    expect(outcome).toMatchObject({ copied: false, reason: 'no_reference' });
    expect(moved.from).toBeUndefined();
    expect(moved.to).toBeUndefined();
  });

  it('leaves the tenancy alone when there is nothing to copy into', async () => {
    const { service, moved } = build([
      postgres('reference-db', 'flui-sandbox-reference'),
    ]);

    expect(await service.copyInto(tenant)).toMatchObject({
      copied: false,
      reason: 'no_target',
    });
    expect(moved.to).toBeUndefined();
  });

  it('ignores an application in the reference namespace that is not a database', async () => {
    const notADatabase = {
      ...postgres('web', 'flui-sandbox-reference'),
      imageRef: 'nginx:1.27',
    };
    const { service } = build([
      notADatabase,
      postgres('guest-db', 'user-guest-abc'),
    ]);

    expect(await service.copyInto(tenant)).toMatchObject({
      reason: 'no_reference',
    });
  });

  /**
   * A shallow history is a worse demo; a tenancy that failed to build is no
   * demo at all. Every failure here is reported, never thrown.
   */
  it.each([
    ['the dump', { dumpFails: true }],
    ['the restore', { restoreFails: true }],
  ])('reports rather than throws when %s fails', async (_label, behaviour) => {
    const { service } = build(
      [
        postgres('reference-db', 'flui-sandbox-reference'),
        postgres('guest-db', 'user-guest-abc'),
      ],
      behaviour,
    );

    await expect(service.copyInto(tenant)).resolves.toMatchObject({
      copied: false,
      reason: 'copy_failed',
    });
  });

  /**
   * The lookups too, not only the copy. A hiccup reading the application rows
   * must not turn a tenancy that built perfectly well into a failed one over
   * the part of it that is decoration.
   */
  it('reports rather than throws when it cannot even look the databases up', async () => {
    const applications = {
      find: async () => {
        throw new Error('connection terminated');
      },
    };
    const service = new SandboxHistoryService(
      {} as never,
      applications as never,
      config,
    );

    await expect(service.copyInto(tenant)).resolves.toMatchObject({
      copied: false,
      reason: 'copy_failed',
    });
  });

  it('reports how long it took, which is what decides where this runs', async () => {
    const { service } = build([
      postgres('reference-db', 'flui-sandbox-reference'),
      postgres('guest-db', 'user-guest-abc'),
    ]);

    const outcome = await service.copyInto(tenant);
    expect(outcome.seconds).toBeGreaterThanOrEqual(0);
    expect(outcome.seconds).toBeLessThan(10);
  });
});
