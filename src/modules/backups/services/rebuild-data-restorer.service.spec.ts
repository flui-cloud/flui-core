// The Kubernetes client ships ESM and this project's jest transforms only
// `jose`; this service reaches it only through the engine registry, stubbed
// here, so nothing it defines is ever called.
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { RebuildDataRestorer } from './rebuild-data-restorer.service';

/**
 * What this service decides is the difference between an application that comes
 * back with its data and one that comes back looking fine and empty.
 *
 * Every test is a way the second used to happen: a claim filled under a name
 * the workload does not ask for, a database restored as a pile of files, a
 * volume reported as protected by a copy nobody holds the credentials for.
 */
describe('RebuildDataRestorer', () => {
  const destination = {
    id: 'dest-1',
    name: 'scaleway',
    bucket: 'flui-backups',
    endpoint: 'https://s3.fr-par.scw.cloud',
    region: 'fr-par',
    accessKeyEncrypted: 'AK',
    secretKeyEncrypted: 'SK',
  } as never;

  function make(opts: {
    dbPolicy?: unknown;
    dbArtifact?: unknown;
    volumeArtifacts?: Record<string, unknown>;
    destination?: unknown;
    engine?: Record<string, unknown>;
  }) {
    const service = Object.create(
      RebuildDataRestorer.prototype,
    ) as RebuildDataRestorer;
    const r = service as unknown as Record<string, unknown>;
    r.logger = { log: jest.fn(), warn: jest.fn() };
    r.appRepo = { save: jest.fn(async (a: unknown) => a) };
    r.policyRepo = { findDbPolicyForApp: async () => opts.dbPolicy ?? null };
    r.artifactRepo = {
      findLatestDbArtifactForApp: async () => opts.dbArtifact ?? null,
      findLatestVolumeCopyForApp: async (_id: string, claim: string) =>
        (opts.volumeArtifacts ?? {})[claim] ?? null,
    };
    r.destRepo = {
      findById: async () =>
        opts.destination === undefined ? destination : opts.destination,
    };
    r.encryption = { decrypt: (v: string) => `plain-${v}` };
    r.destinations = { decryptPassphrase: () => 'dest-passphrase' };
    r.engines = {
      all: () => [{ restoreEnvPrefix: 'FLUI_POSTGRES_' }],
      forEngine: () =>
        opts.engine ?? {
          restoreEnvPrefix: 'FLUI_POSTGRES_',
          buildRestoreEnv: () => ({
            FLUI_POSTGRES_RESTORE: '1',
            FLUI_POSTGRES_S3_SECRET: 'shh',
          }),
        },
    };
    return service;
  }

  const app = (over: Record<string, unknown> = {}) =>
    ({
      id: 'app-1',
      slug: 'linkding-7a6d82-h7ppt8',
      name: 'fixture-web',
      workloadKind: 'Deployment',
      env: [{ name: 'TZ', value: 'UTC' }],
      volumes: [{ name: 'data', mountPath: '/etc/linkding/data' }],
      companions: {},
      ...over,
    }) as never;

  const copy = (over: Record<string, unknown> = {}) => ({
    id: 'art-1',
    engineRef: 'export-1',
    manifestSummary: { sink: 's3-archive' },
    locations: [
      {
        role: 'primary',
        destinationId: 'dest-1',
        objectKeyPrefix: 'flui/cl-1/linkding/20260905120000-abc',
      },
    ],
    ...over,
  });

  describe('the claim it fills', () => {
    it('is the one a Deployment will ask for', async () => {
      // The ledger records the live PVC's name, and the workload asks for
      // `<slug>-<volume>`. Looking one up under the other finds nothing and
      // reports the volume as never copied.
      const seen: string[] = [];
      const service = make({});
      (
        service as unknown as Record<string, Record<string, unknown>>
      ).artifactRepo.findLatestVolumeCopyForApp = async (
        _id: string,
        claim: string,
      ) => {
        seen.push(claim);
        return null;
      };

      await service.restoreInto(app(), {} as never);
      expect(seen).toEqual(['linkding-7a6d82-h7ppt8-data']);
    });

    it('is the first replica’s claim for a StatefulSet', async () => {
      const seen: string[] = [];
      const service = make({});
      (
        service as unknown as Record<string, Record<string, unknown>>
      ).artifactRepo.findLatestVolumeCopyForApp = async (
        _id: string,
        claim: string,
      ) => {
        seen.push(claim);
        return null;
      };

      await service.restoreInto(
        app({ workloadKind: 'StatefulSet' }),
        {} as never,
      );
      expect(seen).toEqual(['data-linkding-7a6d82-h7ppt8-0']);
    });

    it('follows a volume swap rather than the generated name', async () => {
      const seen: string[] = [];
      const service = make({});
      (
        service as unknown as Record<string, Record<string, unknown>>
      ).artifactRepo.findLatestVolumeCopyForApp = async (
        _id: string,
        claim: string,
      ) => {
        seen.push(claim);
        return null;
      };

      await service.restoreInto(
        app({
          volumes: [
            {
              name: 'data',
              mountPath: '/d',
              claimNameOverride: 'data-restored-20260101',
            },
          ],
        }),
        {} as never,
      );
      expect(seen).toEqual(['data-restored-20260101']);
    });
  });

  describe('what it refuses to restore as files', () => {
    it('will not put a database data directory back as a file copy', async () => {
      // The copy's own preflight saw a data directory on the volume. Restoring
      // one file by file produces a server that does not start, and it is
      // reported as protection until somebody tries.
      const service = make({
        volumeArtifacts: {
          'linkding-7a6d82-h7ppt8-data': copy({
            manifestSummary: {
              sink: 's3-archive',
              dataDirectoryDetected: 'postgres',
            },
          }),
        },
      });

      const [outcome] = await service.restoreInto(app(), {} as never);
      expect(outcome.kind).toBe('empty');
      expect((outcome as { why: string }).why).toMatch(
        /a file copy of one does not restore/,
      );
    });

    it('says the engine handled it when the database is under continuous backup', async () => {
      const service = make({
        dbPolicy: { id: 'pol-1', engine: 'postgres' },
        dbArtifact: { id: 'art-db', engineRef: 'base-1', locations: [] },
        volumeArtifacts: {
          'linkding-7a6d82-h7ppt8-data': copy({
            manifestSummary: {
              sink: 's3-archive',
              dataDirectoryDetected: 'postgres',
            },
          }),
        },
      });

      const outcomes = await service.restoreInto(app(), {} as never);
      const volume = outcomes.find((o) => o.what === 'data');
      expect((volume as { why: string }).why).toMatch(/through its engine/);
    });
  });

  describe('what it restores as files because the copy is whole', () => {
    it.each([
      ['redis', 'redis-bgsave'],
      ['valkey', 'valkey-bgsave'],
    ])(
      'puts back a %s copy taken through its save hook',
      async (engine, hook) => {
        // The hook made the engine write a whole snapshot and rename it into
        // place before the copy read it; skipping it brought the cache back empty.
        const service = make({
          volumeArtifacts: {
            'linkding-7a6d82-h7ppt8-data': copy({
              manifestSummary: {
                sink: 's3-archive',
                quiesce: 'engine-hook',
                dataDirectoryDetected: engine,
                hook,
              },
            }),
          },
        });

        const [outcome] = await service.restoreInto(app(), {} as never);
        expect(outcome.kind).toBe('volume');
      },
    );

    it('puts back a SQLite copy read through its online backup', async () => {
      const service = make({
        volumeArtifacts: {
          'linkding-7a6d82-h7ppt8-data': copy({
            manifestSummary: {
              sink: 's3-archive',
              quiesce: 'sqlite-snapshot',
              dataDirectoryDetected: 'sqlite',
              hook: 'sqlite-online-backup',
            },
          }),
        },
      });

      const [outcome] = await service.restoreInto(app(), {} as never);
      expect(outcome.kind).toBe('volume');
    });

    it('still refuses a copy taken live at the person’s own risk', async () => {
      const service = make({
        volumeArtifacts: {
          'linkding-7a6d82-h7ppt8-data': copy({
            manifestSummary: {
              sink: 's3-archive',
              quiesce: 'none',
              dataDirectoryDetected: 'mongodb',
              acknowledgedInconsistent: true,
            },
          }),
        },
      });

      const [outcome] = await service.restoreInto(app(), {} as never);
      expect(outcome.kind).toBe('empty');
    });

    it('leaves a database to its engine even when its copy was taken at rest', async () => {
      const service = make({
        dbPolicy: { id: 'pol-1', engine: 'postgres' },
        dbArtifact: { id: 'art-db', engineRef: 'base-1', locations: [] },
        volumeArtifacts: {
          'linkding-7a6d82-h7ppt8-data': copy({
            manifestSummary: {
              sink: 's3-archive',
              quiesce: 'writers-stopped',
              dataDirectoryDetected: 'postgres',
            },
          }),
        },
      });

      const outcomes = await service.restoreInto(app(), {} as never);
      const volume = outcomes.find((o) => o.what === 'data');
      expect(volume?.kind).toBe('empty');
    });
  });

  describe('a database protected by dumps', () => {
    const dumpArtifact = {
      id: 'art-dump',
      engine: 'postgres-dump',
      engineRef: '20260930T030000Z',
      locations: [{ role: 'primary', destinationId: 'dest-1' }],
    };
    const dumpEngine = (load = jest.fn(async () => undefined)) => ({
      engine: 'postgres-dump',
      pointInTime: false,
      restoreEnvPrefix: 'FLUI_DUMP_',
      buildRestoreEnv: () => ({}),
      loadIntoRestored: load,
    });

    it('says the dump is loaded after the deploy, and writes nothing for boot', async () => {
      const service = make({
        dbPolicy: { id: 'pol-1', engine: 'postgres-dump' },
        dbArtifact: dumpArtifact,
        engine: dumpEngine(),
      });
      const target = app({ volumes: [] });

      const [outcome] = await service.restoreInto(target, {} as never);

      expect(outcome).toEqual({
        kind: 'database',
        what: 'database',
        from: 'the dump 20260930T030000Z, loaded once the database is running',
      });
      expect((target as { env: unknown[] }).env).toEqual([
        { name: 'TZ', value: 'UTC' },
      ]);
    });

    it('loads the newest dump into the rebuilt database', async () => {
      const load = jest.fn(async () => undefined);
      const service = make({
        dbPolicy: { id: 'pol-1', engine: 'postgres-dump' },
        dbArtifact: dumpArtifact,
        engine: dumpEngine(load),
      });

      const note = await service.loadDump('app-1');

      expect(load).toHaveBeenCalledWith('app-1', {
        sourceAppId: 'app-1',
        engineRef: '20260930T030000Z',
        destination,
      });
      expect(note).toMatch(/loaded the dump 20260930T030000Z/);
    });

    it('says the database is running without it when the load fails', async () => {
      const service = make({
        dbPolicy: { id: 'pol-1', engine: 'postgres-dump' },
        dbArtifact: dumpArtifact,
        engine: dumpEngine(
          jest.fn(async () => {
            throw new Error('pg_restore: connection refused');
          }),
        ),
      });

      await expect(service.loadDump('app-1')).rejects.toThrow(
        /could not be loaded, so the database is running without it: pg_restore: connection refused/,
      );
    });

    it('has nothing to load for an engine that restores at boot', async () => {
      const service = make({
        dbPolicy: { id: 'pol-1', engine: 'postgres' },
        dbArtifact: { id: 'art-db', engineRef: 'base-1', locations: [] },
      });

      expect(await service.loadDump('app-1')).toBeNull();
    });

    it('has nothing to load without a policy or a dump', async () => {
      expect(await make({}).loadDump('app-1')).toBeNull();
      expect(
        await make({
          dbPolicy: { id: 'pol-1', engine: 'postgres-dump' },
          dbArtifact: null,
          engine: dumpEngine(),
        }).loadDump('app-1'),
      ).toBeNull();
    });
  });

  describe('what it says when it cannot', () => {
    it('separates a copy it cannot read from a copy that does not exist', async () => {
      // `record()` writes a location only when the copy went to a registered
      // destination. Reporting "no copy" for one taken against a bucket
      // somebody passed by hand sends its owner looking for the wrong thing.
      const service = make({
        volumeArtifacts: {
          'linkding-7a6d82-h7ppt8-data': copy({ locations: [] }),
        },
      });

      const [outcome] = await service.restoreInto(app(), {} as never);
      expect((outcome as { why: string }).why).toMatch(/no credentials/);
    });

    it('does not stop at the database when there is nothing to restore it from', async () => {
      // An application can be a database with an uploads directory beside it.
      // Returning early on the database left the volume unexamined and silent.
      const service = make({
        dbPolicy: { id: 'pol-1', engine: 'postgres' },
        dbArtifact: null,
        volumeArtifacts: {
          'linkding-7a6d82-h7ppt8-data': copy(),
        },
      });

      const outcomes = await service.restoreInto(app(), {} as never);
      expect(outcomes.map((o) => o.what)).toEqual(['database', 'data']);
      expect(outcomes[1].kind).toBe('volume');
    });
  });

  describe('the init container it writes', () => {
    it('copies rather than syncs, and stops on a marker', async () => {
      // A sync makes the claim match the bucket: a pod that restarts after the
      // application has written would delete that work.
      const service = make({
        volumeArtifacts: { 'linkding-7a6d82-h7ppt8-data': copy() },
      });
      const row = app();

      await service.restoreInto(row, {} as never);
      const init = (row as never as { companions: { initContainers: never[] } })
        .companions.initContainers[0] as unknown as {
        name: string;
        command: string[];
        mounts: Array<{ name: string }>;
      };

      expect(init.name).toBe('flui-restore-data');
      expect(init.command[2]).toMatch(/rclone copy/);
      expect(init.command[2]).not.toMatch(/rclone sync/);
      expect(init.command[2]).toMatch(/\.flui-restored/);
      expect(init.mounts[0].name).toBe('data');
    });

    it('keeps the bucket credentials out of the pod spec', async () => {
      // They land in the application's own Secret, which is what `inheritAppEnv`
      // reads — a value in the container spec is readable by anyone who can get
      // the pod, and is stored in the cluster datastore in the clear.
      const service = make({
        volumeArtifacts: { 'linkding-7a6d82-h7ppt8-data': copy() },
      });
      const row = app();

      await service.restoreInto(row, {} as never);
      const env = (row as never as { env: Array<Record<string, unknown>> }).env;
      const secret = env.find(
        (e) => e.name === 'RCLONE_CONFIG_FLUI_SECRET_ACCESS_KEY',
      );
      expect(secret?.secret).toBe(true);
      expect(secret?.value).toBe('plain-SK');

      const init = (row as never as { companions: { initContainers: never[] } })
        .companions.initContainers[0] as unknown as {
        inheritAppEnv: boolean;
        env: Array<{ name: string; value: string }>;
      };
      expect(init.inheritAppEnv).toBe(true);
      expect(init.env.map((e) => e.name)).toEqual([
        'FLUI_RESTORE_PREFIX',
        'FLUI_RESTORE_OWN',
        'FLUI_RESTORE_ENCRYPTED',
      ]);
    });

    it('reads an encrypted copy through flui_crypt, its key in the Secret only', async () => {
      const service = make({
        volumeArtifacts: {
          'linkding-7a6d82-h7ppt8-data': copy({
            manifestSummary: {
              sink: 's3-archive',
              repository: { objectKeyPrefix: 'p', cipher: 'rclone-crypt-v1' },
            },
          }),
        },
      });
      const row = app();

      await service.restoreInto(row, {} as never);
      const env = (row as never as { env: Array<Record<string, unknown>> }).env;
      const keys = env.filter((e) =>
        String(e.name).startsWith('FLUI_RESTORE_CRYPT_'),
      );
      expect(keys.map((e) => e.name)).toEqual([
        'FLUI_RESTORE_CRYPT_PASSWORD',
        'FLUI_RESTORE_CRYPT_PASSWORD2',
      ]);
      expect(keys.every((e) => e.secret === true)).toBe(true);

      const init = (row as never as { companions: { initContainers: never[] } })
        .companions.initContainers[0] as unknown as {
        command: string[];
        env: Array<{ name: string; value: string }>;
      };
      expect(
        init.env.find((e) => e.name === 'FLUI_RESTORE_ENCRYPTED')?.value,
      ).toBe('1');
      expect(init.command[2]).toContain('REMOTE=flui_crypt');
      expect(init.command[2]).toContain('rclone obscure -');
      for (const k of keys) {
        expect(JSON.stringify(init)).not.toContain(String(k.value));
      }
    });

    it('reads a copy taken before encryption in plain, and adds no key', async () => {
      const service = make({
        volumeArtifacts: { 'linkding-7a6d82-h7ppt8-data': copy() },
      });
      const row = app();

      await service.restoreInto(row, {} as never);
      const env = (row as never as { env: Array<{ name: string }> }).env;
      expect(env.some((e) => e.name.startsWith('FLUI_RESTORE_CRYPT_'))).toBe(
        false,
      );
      const init = (row as never as { companions: { initContainers: never[] } })
        .companions.initContainers[0] as unknown as {
        env: Array<{ name: string; value: string }>;
      };
      expect(
        init.env.find((e) => e.name === 'FLUI_RESTORE_ENCRYPTED')?.value,
      ).toBe('');
    });

    it('does not restore from a copy whose plaintext was retired', async () => {
      const service = make({
        volumeArtifacts: {
          'linkding-7a6d82-h7ppt8-data': copy({
            locations: [
              {
                role: 'primary',
                destinationId: 'dest-1',
                objectKeyPrefix: 'flui/cl-1/linkding/old',
                state: 'expired',
              },
            ],
          }),
        },
      });

      const [outcome] = await service.restoreInto(app(), {} as never);
      expect(outcome.kind).toBe('empty');
    });

    it('hands the restored files to the user the application runs as', async () => {
      const service = make({
        volumeArtifacts: { 'linkding-7a6d82-h7ppt8-data': copy() },
      });
      const row = app({ securityContext: { runAsUser: 1000, fsGroup: 1000 } });

      await service.restoreInto(row, {} as never);
      const init = (row as never as { companions: { initContainers: never[] } })
        .companions.initContainers[0] as unknown as {
        env: Array<{ name: string; value: string }>;
      };
      expect(init.env.find((e) => e.name === 'FLUI_RESTORE_OWN')?.value).toBe(
        '1000:1000',
      );
    });
  });

  describe('preview', () => {
    it('decides the same thing without writing any of it', async () => {
      const service = make({
        volumeArtifacts: { 'linkding-7a6d82-h7ppt8-data': copy() },
      });
      const row = app();

      const outcomes = await service.preview(row);
      expect(outcomes[0].kind).toBe('volume');
      expect(
        (row as never as { companions: { initContainers?: never[] } })
          .companions.initContainers,
      ).toBeUndefined();
      expect(
        (row as never as { env: Array<{ name: string }> }).env.map(
          (e) => e.name,
        ),
      ).toEqual(['TZ']);
    });
  });

  describe('forget', () => {
    it('takes the credentials and the init container back off the row', async () => {
      const service = make({
        volumeArtifacts: { 'linkding-7a6d82-h7ppt8-data': copy() },
      });
      const row = app({
        env: [
          { name: 'TZ', value: 'UTC' },
          { name: 'FLUI_POSTGRES_RESTORE', value: '1' },
        ],
      });
      await service.restoreInto(row, {} as never);
      (
        service as unknown as Record<string, Record<string, unknown>>
      ).appRepo.findOne = async () => row;

      await service.forget('app-1');

      const r = row as never as {
        env: Array<{ name: string }>;
        companions: { initContainers: never[] };
      };
      expect(r.env.map((e) => e.name)).toEqual(['TZ']);
      expect(r.companions.initContainers).toEqual([]);
    });
  });

  describe('how far back the database comes', () => {
    it('asks for the last archived moment, never for the backup set itself', async () => {
      // Naming the artifact's label pinned recovery to when that backup was
      // taken. On a real rebuild the base was 3h51m old, every WAL since was
      // archived without error, and the database came back missing all of it
      // and reported success. Both engines read "no target" as "newest base,
      // then everything after it".
      const built: unknown[][] = [];
      const service = make({
        dbPolicy: { id: 'pol-1', engine: 'postgres' },
        dbArtifact: {
          id: 'art-db',
          engineRef: '20260905-193009F',
          locations: [{ role: 'primary', destinationId: 'dest-1' }],
        },
      });
      (service as unknown as Record<string, Record<string, unknown>>).engines =
        {
          all: () => [{ restoreEnvPrefix: 'FLUI_PG_' }],
          forEngine: () => ({
            restoreEnvPrefix: 'FLUI_PG_',
            buildRestoreEnv: (...args: unknown[]) => {
              built.push(args);
              return { FLUI_PG_RESTORE: '1' };
            },
          }),
        };

      const [outcome] = await service.restoreInto(
        app({ volumes: [] }),
        {} as never,
      );

      // third arg = instant, fourth = base label. Both must be absent.
      expect(built[0][2]).toBeUndefined();
      expect(built[0][3]).toBeUndefined();
      expect((outcome as { from: string }).from).toMatch(
        /every log archived after it/,
      );
    });

    it('restores from the repository the artifact names, and keeps its key in the Secret', async () => {
      const built: unknown[][] = [];
      const summary = {
        repository: {
          objectKeyPrefix: 'pgbackrest/app-1/encrypted/',
          cipher: 'aes-256-cbc',
        },
      };
      const service = make({
        dbPolicy: { id: 'pol-1', engine: 'postgres' },
        dbArtifact: {
          id: 'art-db',
          manifestSummary: summary,
          locations: [{ role: 'primary', destinationId: 'dest-1' }],
        },
      });
      (service as unknown as Record<string, Record<string, unknown>>).engines =
        {
          all: () => [{ restoreEnvPrefix: 'FLUI_PG_' }],
          forEngine: () => ({
            restoreEnvPrefix: 'FLUI_PG_',
            buildRestoreEnv: (...args: unknown[]) => {
              built.push(args);
              return { FLUI_PG_RESTORE: '1', FLUI_PG_CIPHER_PASS: 'k' };
            },
          }),
        };
      const row = app({ volumes: [] });

      await service.restoreInto(row, {} as never);

      expect(built[0][5]).toBe(summary);
      const env = (row as never as { env: Array<Record<string, unknown>> }).env;
      expect(env.find((e) => e.name === 'FLUI_PG_CIPHER_PASS')?.secret).toBe(
        true,
      );
    });
  });
  describe('a volume whose newest copy is a kopia snapshot', () => {
    const kopiaCopy = (over: Record<string, unknown> = {}) =>
      copy({
        id: 'art-k',
        engine: 'kopia',
        createdAt: new Date('2026-09-30T03:30:00Z'),
        manifestSummary: {
          sink: 'kopia',
          quiesce: 'none',
          kopia: {
            snapshotId: 'k0123456789abcdef',
            rootObject: 'kroot',
            source: 'flui@flui-app-1:/flui/volumes/linkding-7a6d82-h7ppt8-data',
            repositoryPrefix: 'kopia/app-1/',
          },
        },
        locations: [
          {
            role: 'primary',
            destinationId: 'dest-1',
            state: 'available',
            objectKeyPrefix: 'kopia/app-1/',
          },
        ],
        ...over,
      });

    it('fills the volume with kopia, read-only, before the application starts', async () => {
      const service = make({
        volumeArtifacts: { 'linkding-7a6d82-h7ppt8-data': kopiaCopy() },
      });
      const row = app();

      const outcomes = await service.restoreInto(row, {} as never);

      expect(outcomes).toEqual([
        {
          kind: 'volume',
          what: 'data',
          from: 'the kopia snapshot k0123456789abcdef, taken 2026-09-30 03:30 UTC',
        },
      ]);
      const companions = (row as never as { companions: any }).companions;
      const init = companions.initContainers[0];
      expect(init.name).toBe('flui-restore-data');
      expect(init.image).toMatch(/^kopia\/kopia:0\.23\.1@sha256:/);
      const script = init.command[2] as string;
      expect(script).toContain('repository connect "$@" --readonly');
      expect(script).toContain('--override-username=flui-api');
      expect(script).toContain('.flui-restored');
      expect(init.mounts).toEqual([
        { name: 'data', mountPath: '/flui-restore' },
        { name: 'flui-restore-kopia-work', mountPath: '/flui/work' },
      ]);
      expect(companions.volumes).toEqual([
        { name: 'flui-restore-kopia-work', emptyDir: { sizeLimit: '2Gi' } },
      ]);
      const env = Object.fromEntries(
        init.env.map((e: { name: string; value: string }) => [e.name, e.value]),
      );
      expect(env.FLUI_KOPIA_PRIMARY).toBe('k0123456789abcdef');
      expect(env.FLUI_KOPIA_BUCKET).toBe('flui-backups');
      expect(env.FLUI_KOPIA_ENDPOINT).toBe('s3.fr-par.scw.cloud');
      expect(env.FLUI_KOPIA_PREFIX).toBe('kopia/app-1/');
      expect(env.FLUI_KOPIA_HOST).toBe('flui-app-1');
      expect(env.FLUI_KOPIA_SQLITE).toBeUndefined();
    });

    it('keeps the repository password and the keys in the Secret, under names no AWS client reads', async () => {
      const service = make({
        volumeArtifacts: { 'linkding-7a6d82-h7ppt8-data': kopiaCopy() },
      });
      const row = app();

      await service.restoreInto(row, {} as never);

      const env = (row as never as { env: Array<Record<string, unknown>> }).env;
      const byName = Object.fromEntries(env.map((e) => [e.name, e]));
      for (const name of [
        'FLUI_RESTORE_KOPIA_PASSWORD',
        'FLUI_RESTORE_KOPIA_ACCESS_KEY',
        'FLUI_RESTORE_KOPIA_SECRET_KEY',
      ]) {
        expect(byName[name]?.secret).toBe(true);
      }
      expect(byName.FLUI_RESTORE_KOPIA_ACCESS_KEY.value).toBe('plain-AK');
      // The same derivation the snapshot Jobs used, from the same passphrase.
      const { deriveKopiaPassword } = jest.requireActual(
        '../utils/kopia-repository.util',
      );
      expect(byName.FLUI_RESTORE_KOPIA_PASSWORD.value).toBe(
        deriveKopiaPassword('dest-passphrase', 'app-1'),
      );
      expect(env.some((e) => String(e.name).startsWith('AWS_'))).toBe(false);
      expect(env.some((e) => String(e.name).startsWith('RCLONE_'))).toBe(false);
      const init = (row as never as { companions: any }).companions
        .initContainers[0];
      expect(JSON.stringify(init.env)).not.toContain('plain-');
    });

    it('lays the SQLite copies over the volume, the way a restore Job does', async () => {
      const summary = kopiaCopy().manifestSummary as Record<string, any>;
      const service = make({
        volumeArtifacts: {
          'linkding-7a6d82-h7ppt8-data': kopiaCopy({
            manifestSummary: {
              ...summary,
              quiesce: 'sqlite-snapshot',
              dataDirectoryDetected: 'sqlite',
              kopia: {
                ...summary.kopia,
                sqlite: {
                  snapshotId: 'ksqlite',
                  rootObject: 'r',
                  source: 's',
                },
              },
            },
          }),
        },
      });
      const row = app();

      await service.restoreInto(row, {} as never);

      const init = (row as never as { companions: any }).companions
        .initContainers[0];
      const env = Object.fromEntries(
        init.env.map((e: { name: string; value: string }) => [e.name, e.value]),
      );
      expect(env.FLUI_KOPIA_SQLITE).toBe('ksqlite');
      const script = init.command[2] as string;
      expect(script.indexOf('"$FLUI_KOPIA_PRIMARY" "$d"')).toBeLessThan(
        script.indexOf('"$FLUI_KOPIA_SQLITE" "$d"'),
      );
    });

    it('restores an rclone archive and a kopia snapshot side by side from one destination', async () => {
      const service = make({
        volumeArtifacts: {
          'linkding-7a6d82-h7ppt8-data': kopiaCopy(),
          'linkding-7a6d82-h7ppt8-media': copy(),
        },
      });
      const row = app({
        volumes: [
          { name: 'data', mountPath: '/d' },
          { name: 'media', mountPath: '/m' },
        ],
      });

      const outcomes = await service.restoreInto(row, {} as never);

      expect(outcomes.map((o) => o.kind)).toEqual(['volume', 'volume']);
      const images = (
        row as never as { companions: any }
      ).companions.initContainers.map((c: { image: string }) => c.image);
      expect(images[0]).toMatch(/^kopia\//);
      expect(images[1]).toMatch(/^rclone\//);
      const names = (row as never as { env: Array<{ name: string }> }).env.map(
        (e) => e.name,
      );
      expect(names).toEqual(
        expect.arrayContaining([
          'RCLONE_CONFIG_FLUI_ACCESS_KEY_ID',
          'FLUI_RESTORE_KOPIA_PASSWORD',
        ]),
      );
    });

    it('says why when the destination holds no passphrase to open the repository', async () => {
      const service = make({
        volumeArtifacts: { 'linkding-7a6d82-h7ppt8-data': kopiaCopy() },
      });
      (service as unknown as Record<string, unknown>).destinations = {
        decryptPassphrase: () => undefined,
      };
      const row = app();

      const outcomes = await service.restoreInto(row, {} as never);

      expect(outcomes).toEqual([
        {
          kind: 'empty',
          what: 'data',
          why: expect.stringMatching(/holds no passphrase/),
        },
      ]);
      expect(
        (row as never as { companions: any }).companions.initContainers,
      ).toBeUndefined();
    });

    it('takes the kopia init container, its work volume and its keys back off the row', async () => {
      const service = make({
        volumeArtifacts: { 'linkding-7a6d82-h7ppt8-data': kopiaCopy() },
      });
      const row = app({
        companions: { volumes: [{ name: 'shipper-conf', emptyDir: {} }] },
      });
      await service.restoreInto(row, {} as never);
      (service as unknown as Record<string, unknown>).appRepo = {
        findOne: async () => row,
        save: jest.fn(async (a: unknown) => a),
      };

      await service.forget('app-1');

      const after = row as never as {
        env: Array<{ name: string }>;
        companions: any;
      };
      expect(after.env).toEqual([{ name: 'TZ', value: 'UTC' }]);
      expect(after.companions.initContainers).toEqual([]);
      expect(after.companions.volumes).toEqual([
        { name: 'shipper-conf', emptyDir: {} },
      ]);
    });
  });
});
