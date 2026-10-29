import { load } from 'js-yaml';
import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';
import { PoolerSpec } from '../utils/db-pooler.core';
import { DatabaseHaSpec } from '../../postgres-ha/postgres-ha.types';

const generator = new ApplicationManifestGeneratorService({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
} as unknown as EncryptionService);

const pooler: PoolerSpec = {
  enabled: true,
  mode: 'transaction',
  replicas: 1,
  image: 'ghcr.io/cloudnative-pg/pgbouncer:1.26.0',
  authPasswordEnc: 'enc:authpw',
  adminPasswordEnc: 'enc:adminpw',
  upstream: { mode: 'local' },
  enabledAt: '2026-10-12T00:00:00.000Z',
};

const ha = (state: DatabaseHaSpec['state']): DatabaseHaSpec => ({
  engine: 'cnpg',
  cluster: 'postgresql-ab12-ha',
  durability: 'required',
  instances: 2,
  state,
  since: '2026-10-28T17:25:00.000Z',
});

function database(over: Partial<ApplicationEntity> = {}): ApplicationEntity {
  return {
    id: 'db-1',
    slug: 'postgresql-ab12',
    name: 'postgresql-ab12',
    kind: 'DATABASE',
    k8sNamespace: 'user-x',
    replicas: 1,
    port: 5432,
    workloadKind: 'StatefulSet',
    persistenceScope: 'dedicated',
    dedicatedNodeName: 'worker-1',
    labels: { 'flui.cloud/db-engine': 'postgres' },
    volumes: [{ name: 'data', mountPath: '/var/lib/postgresql', size: '10Gi' }],
    env: [
      { name: 'POSTGRES_DB', value: 'postgresql-ab12' },
      { name: 'POSTGRES_USER', value: 'postgresql-ab12' },
      { name: 'POSTGRES_PASSWORD', value: 'enc:pw', secret: true },
    ],
    sourceConfig: {
      type: 'docker_image',
      imageRef: 'ghcr.io/flui-cloud/flui-postgres:17',
    },
    ...over,
  } as unknown as ApplicationEntity;
}

type Doc = { kind: string; metadata: { name: string }; spec?: any };

const render = (app: ApplicationEntity) =>
  generator.generateForDockerImage(app).map((m) => ({
    ...m,
    doc: load(m.yaml) as Doc,
  }));

const find = (app: ApplicationEntity, kind: string, name: string) =>
  render(app).find((m) => m.doc.kind === kind && m.doc.metadata.name === name);

describe('a managed Postgres that moved to a highly available cluster', () => {
  /** Byte for byte, so no existing database is redeployed because this exists. */
  it('renders exactly as before while it is a single instance or still copying', () => {
    const before = render(database()).map((m) => m.yaml);
    expect(render(database({ databaseHa: null })).map((m) => m.yaml)).toEqual(
      before,
    );
    expect(
      render(database({ databaseHa: ha('copying') })).map((m) => m.yaml),
    ).toEqual(before);
    expect(
      render(database({ databaseHa: ha('failed') })).map((m) => m.yaml),
    ).toEqual(before);
  });

  it("points the application's address at the cluster's primary once it serves", () => {
    expect(
      find(database(), 'Service', 'postgresql-ab12-svc')!.doc.spec.selector,
    ).toEqual({ app: 'postgresql-ab12' });
    expect(
      find(
        database({ databaseHa: ha('active') }),
        'Service',
        'postgresql-ab12-svc',
      )!.doc.spec.selector,
    ).toEqual({
      'cnpg.io/cluster': 'postgresql-ab12-ha',
      'cnpg.io/instanceRole': 'primary',
    });
  });

  /** Its volume is the way back if the move has to be undone. */
  it('keeps the single instance at zero copies instead of removing it', () => {
    const sts = find(
      database({ databaseHa: ha('active') }),
      'StatefulSet',
      'postgresql-ab12',
    )!;
    expect(sts.doc.spec.replicas).toBe(0);
    expect(
      find(database(), 'StatefulSet', 'postgresql-ab12')!.doc.spec.replicas,
    ).toBe(1);
  });

  it('sends the pooler to the primary and lets it run on any node', () => {
    const docs = generator
      .generatePooler(database({ pooler, databaseHa: ha('active') }))
      .map((m) => load(m.yaml) as Doc);
    const upstream = docs.find(
      (d) => d.metadata.name === 'postgresql-ab12-pooler-upstream',
    )!;
    expect(upstream.spec.selector).toEqual({
      'cnpg.io/cluster': 'postgresql-ab12-ha',
      'cnpg.io/instanceRole': 'primary',
    });
    const deployment = docs.find((d) => d.kind === 'Deployment')!;
    expect(deployment.spec.template.spec.affinity).toBeUndefined();
    expect(deployment.spec.template.spec.nodeSelector).toBeUndefined();
  });
});
