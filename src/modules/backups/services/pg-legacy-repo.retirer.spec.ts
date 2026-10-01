import { PgLegacyRepoRetirer } from './pg-legacy-repo.retirer';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';

const APP = 'app-1';
const ENCRYPTED = {
  objectKeyPrefix: `pgbackrest/${APP}/encrypted/`,
  cipher: 'aes-256-cbc',
};

function artifact(id: string, summary: Record<string, unknown>, extra = {}) {
  return {
    id,
    engine: 'postgres',
    manifestSummary: { applicationId: APP, ...summary },
    metadata: {},
    locations: [
      {
        id: `loc-${id}`,
        destinationId: 'dest-1',
        state: ArtifactLocationState.AVAILABLE,
      },
    ],
    ...extra,
  } as any;
}

function make(opts: {
  rows: any[];
  policyMetadata?: Record<string, unknown>;
  runningRestores?: number;
  bucket?: string[];
  stuck?: boolean;
}) {
  let bucket = [...(opts.bucket ?? [])];
  const listed: string[] = [];
  const backend = {
    listObjects: jest.fn(async (_creds: unknown, prefix: string) => {
      listed.push(prefix);
      return {
        keys: bucket.filter((k) => k.startsWith(`root/${prefix}`)),
        hasMore: false,
      };
    }),
    deleteObjects: jest.fn(async (_creds: unknown, keys: string[]) => {
      if (!opts.stuck) bucket = bucket.filter((k) => !keys.includes(k));
    }),
  };
  const artifacts = {
    listDbArtifactsForApp: jest.fn(async () => opts.rows),
    updateLocation: jest.fn(async () => undefined),
    updateArtifactMetadata: jest.fn(async () => undefined),
  };
  const policies = {
    findDbPolicyForApp: jest.fn(async () => ({
      id: 'pol-1',
      metadata: opts.policyMetadata ?? {},
      destinations: [{ destinationId: 'dest-1' }],
    })),
    update: jest.fn(async () => undefined),
  };
  const retirer = new PgLegacyRepoRetirer(
    artifacts as any,
    policies as any,
    {
      findById: jest.fn(async (id: string) => ({ id, provider: 's3' })),
    } as any,
    { toCredentials: jest.fn(() => ({ pathPrefix: 'root' })) } as any,
    { forProvider: () => backend } as any,
    { count: jest.fn(async () => opts.runningRestores ?? 0) } as any,
  );
  return {
    retirer,
    backend,
    artifacts,
    policies,
    listed,
    bucket: () => bucket,
  };
}

const BUCKET = [
  `root/pgbackrest/${APP}/archive/main/000001.gz`,
  `root/pgbackrest/${APP}/backup/main/backup.info`,
  `root/pgbackrest/${APP}/encrypted/archive/main/000001.gz`,
  `root/pgbackrest/${APP}/encrypted/backup/main/backup.info`,
  `root/pgbackrest/other-app/archive/main/000001.gz`,
];

describe('retiring the plaintext pgBackRest repository', () => {
  const legacy = artifact('old', { backupType: 'full' });

  it('does nothing before an encrypted full backup exists', async () => {
    const encryptedIncr = artifact('new', {
      backupType: 'incr',
      repository: ENCRYPTED,
    });
    const t = make({ rows: [encryptedIncr, legacy], bucket: BUCKET });

    await t.retirer.retire(APP, encryptedIncr);

    expect(t.backend.listObjects).not.toHaveBeenCalled();
    expect(t.backend.deleteObjects).not.toHaveBeenCalled();
    expect(t.policies.update).not.toHaveBeenCalled();
  });

  it('does nothing when the repository could not be read back as encrypted', async () => {
    const claimed = artifact('new', {
      backupType: 'full',
      repository: { ...ENCRYPTED, cipher: 'none' },
    });
    const t = make({ rows: [claimed, legacy], bucket: BUCKET });

    await t.retirer.retire(APP, claimed);

    expect(t.backend.deleteObjects).not.toHaveBeenCalled();
  });

  it('after the first encrypted full: removes only the plaintext repository and marks its artifacts', async () => {
    const first = artifact('new', {
      backupType: 'full',
      repository: ENCRYPTED,
    });
    const t = make({ rows: [first, legacy], bucket: BUCKET });

    await t.retirer.retire(APP, first);

    expect(new Set(t.listed)).toEqual(
      new Set([`pgbackrest/${APP}/archive/`, `pgbackrest/${APP}/backup/`]),
    );
    expect(t.bucket()).toEqual([
      `root/pgbackrest/${APP}/encrypted/archive/main/000001.gz`,
      `root/pgbackrest/${APP}/encrypted/backup/main/backup.info`,
      `root/pgbackrest/other-app/archive/main/000001.gz`,
    ]);
    expect(t.artifacts.updateLocation).toHaveBeenCalledTimes(1);
    expect(t.artifacts.updateLocation).toHaveBeenCalledWith(
      'loc-old',
      expect.objectContaining({ state: ArtifactLocationState.EXPIRED }),
    );
    expect(t.artifacts.updateArtifactMetadata).toHaveBeenCalledWith(
      'old',
      expect.objectContaining({ plaintextRetiredAt: expect.any(String) }),
    );
    expect(t.policies.update).toHaveBeenCalledWith('pol-1', {
      metadata: { plaintextRetiredAt: expect.any(String) },
    });
  });

  it('once retired, later backups do not touch the bucket again', async () => {
    const next = artifact('newer', {
      backupType: 'incr',
      repository: ENCRYPTED,
    });
    const t = make({
      rows: [next],
      policyMetadata: { plaintextRetiredAt: '2026-09-30T00:00:00Z' },
      bucket: BUCKET,
    });

    await t.retirer.retire(APP, next);

    expect(t.backend.listObjects).not.toHaveBeenCalled();
  });

  it('waits while a restore is reading the plaintext repository', async () => {
    const first = artifact('new', {
      backupType: 'full',
      repository: ENCRYPTED,
    });
    const t = make({
      rows: [first, legacy],
      runningRestores: 1,
      bucket: BUCKET,
    });

    await t.retirer.retire(APP, first);

    expect(t.backend.deleteObjects).not.toHaveBeenCalled();
    expect(t.policies.update).not.toHaveBeenCalled();
  });

  it('a delete the bucket did not honour is retried on the next backup, and nothing is marked gone', async () => {
    const first = artifact('new', {
      backupType: 'full',
      repository: ENCRYPTED,
    });
    const t = make({ rows: [first, legacy], bucket: BUCKET, stuck: true });

    await t.retirer.retire(APP, first);

    expect(t.artifacts.updateLocation).not.toHaveBeenCalled();
    expect(t.policies.update).not.toHaveBeenCalled();
  });

  it('leaves dump artifacts of the same database alone', async () => {
    const first = artifact('new', {
      backupType: 'full',
      repository: ENCRYPTED,
    });
    const dump = artifact('dump', {}, { engine: 'postgres-dump' });
    const t = make({ rows: [first, dump, legacy], bucket: BUCKET });

    await t.retirer.retire(APP, first);

    expect(t.artifacts.updateLocation).toHaveBeenCalledTimes(1);
    expect(t.artifacts.updateLocation).toHaveBeenCalledWith(
      'loc-old',
      expect.anything(),
    );
  });
});
