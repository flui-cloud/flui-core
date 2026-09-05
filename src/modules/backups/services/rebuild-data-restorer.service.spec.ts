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
    r.engines = {
      all: () => [{ restoreEnvPrefix: 'FLUI_POSTGRES_' }],
      forEngine: () => ({
        restoreEnvPrefix: 'FLUI_POSTGRES_',
        buildRestoreEnv: () => ({
          FLUI_POSTGRES_RESTORE: '1',
          FLUI_POSTGRES_S3_SECRET: 'shh',
        }),
      }),
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
      ]);
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
  });
});
