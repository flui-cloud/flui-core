import { load } from 'js-yaml';
import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';
import { PoolerSpec } from '../utils/db-pooler.core';

const generator = new ApplicationManifestGeneratorService({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => {
    if (!v.startsWith('enc:')) throw new Error('not encrypted');
    return v.slice(4);
  },
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

type Doc = {
  kind: string;
  metadata: { name: string; labels: Record<string, string> };
  spec?: any;
  data?: Record<string, string>;
  endpoints?: any[];
  ports?: any[];
};

const docs = (app: ApplicationEntity): Doc[] =>
  generator.generatePooler(app).map((m) => load(m.yaml) as Doc);

describe('generatePooler', () => {
  it('emits the Secret, the two Services and the Deployment of the pooler', () => {
    expect(
      generator
        .generatePooler(database({ pooler }))
        .map((m) => `${m.kind}/${m.name}`),
    ).toEqual([
      'Secret/postgresql-ab12-pooler',
      'Service/postgresql-ab12-pooler-upstream',
      'Service/postgresql-ab12-pooler',
      'Deployment/postgresql-ab12-pooler',
    ]);
  });

  it('renders nothing for a database without a pooler', () => {
    expect(generator.generatePooler(database())).toEqual([]);
    expect(generator.generatePooler(database({ pooler: null }))).toEqual([]);
  });

  it('never labels a pooler object as the database', () => {
    for (const doc of docs(database({ pooler }))) {
      expect(doc.metadata.labels['flui-app-id']).toBeUndefined();
      expect(doc.metadata.labels['flui.cloud/db-engine']).toBeUndefined();
      expect(doc.metadata.labels['flui.cloud/pooler-of']).toBe('db-1');
      expect(doc.metadata.labels.app).toBe('postgresql-ab12-pooler');
      expect(doc.metadata.labels['app.kubernetes.io/instance']).toBe(
        'postgresql-ab12-pooler',
      );
    }
    const deployment = docs(database({ pooler })).find(
      (d) => d.kind === 'Deployment',
    )!;
    const podLabels = deployment.spec.template.metadata.labels;
    expect(podLabels['flui-app-id']).toBeUndefined();
    expect(podLabels.app).not.toBe('postgresql-ab12');
    expect(podLabels['flui.cloud/pooler-of']).toBe('db-1');
  });

  it("must run on the database pod's node", () => {
    const deployment = docs(database({ pooler })).find(
      (d) => d.kind === 'Deployment',
    )!;
    expect(
      deployment.spec.template.spec.affinity.podAffinity
        .requiredDuringSchedulingIgnoredDuringExecution,
    ).toEqual([
      {
        labelSelector: { matchLabels: { 'flui-app-id': 'db-1' } },
        topologyKey: 'kubernetes.io/hostname',
      },
    ]);
  });

  it('follows a database placed on the control plane with the same tolerations', () => {
    const deployment = docs(
      database({
        pooler,
        dedicatedNodeName: undefined,
        allowMasterPlacement: true,
      }),
    ).find((d) => d.kind === 'Deployment')!;
    expect(deployment.spec.template.spec.tolerations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'node-role.kubernetes.io/control-plane',
        }),
      ]),
    );
  });

  it.each([
    [
      'shared storage allowed on the control plane',
      {
        persistenceScope: 'shared',
        dedicatedNodeName: undefined,
        allowMasterPlacement: true,
      },
    ],
    [
      'shared storage',
      { persistenceScope: 'shared', dedicatedNodeName: undefined },
    ],
    ['dedicated on a worker', {}],
    [
      'dedicated on the control plane',
      { dedicatedNodeName: undefined, allowMasterPlacement: true },
    ],
  ])(
    'copies the node selector and tolerations of a database on %s',
    (_, over) => {
      const app = database({ pooler, ...(over as Partial<ApplicationEntity>) });
      const db = generator
        .generateForDockerImage(app)
        .map((m) => load(m.yaml) as Doc)
        .find((d) => d.kind === 'StatefulSet' || d.kind === 'Deployment')!;
      const pod = docs(app).find((d) => d.kind === 'Deployment')!.spec.template
        .spec;
      expect(pod.nodeSelector).toEqual(db.spec.template.spec.nodeSelector);
      expect(pod.tolerations).toEqual(db.spec.template.spec.tolerations);
    },
  );

  it('points the pooler at the database through the upstream Service and listens on 5432', () => {
    const all = docs(database({ pooler }));
    const upstream = all.find(
      (d) => d.metadata.name === 'postgresql-ab12-pooler-upstream',
    )!;
    expect(upstream.spec.selector).toEqual({ app: 'postgresql-ab12' });
    const service = all.find(
      (d) =>
        d.kind === 'Service' && d.metadata.name === 'postgresql-ab12-pooler',
    )!;
    expect(service.spec.selector).toEqual({ app: 'postgresql-ab12-pooler' });
    expect(service.spec.ports[0]).toMatchObject({
      port: 5432,
      targetPort: 'pgbouncer',
    });
    const ini = Buffer.from(
      all.find((d) => d.kind === 'Secret')!.data!['pgbouncer.ini'],
      'base64',
    ).toString();
    expect(ini).toContain(
      'postgresql-ab12 = host=postgresql-ab12-pooler-upstream.user-x.svc.cluster.local port=5432 dbname=postgresql-ab12 auth_dbname=postgresql-ab12',
    );
    expect(ini).not.toMatch(/^\* =/m);
    expect(ini).toContain('pool_mode = transaction');
    expect(ini).toContain('auth_user = flui_pooler');
  });

  it('renders the session mode the install chose', () => {
    const secret = docs(
      database({ pooler: { ...pooler, mode: 'session' } }),
    ).find((d) => d.kind === 'Secret')!;
    expect(
      Buffer.from(secret.data!['pgbouncer.ini'], 'base64').toString(),
    ).toContain('pool_mode = session');
  });

  it('puts the decrypted pooler passwords in the user list and nowhere in the app env', () => {
    const secret = docs(database({ pooler })).find((d) => d.kind === 'Secret')!;
    expect(Buffer.from(secret.data!['userlist.txt'], 'base64').toString()).toBe(
      '"flui_pooler" "authpw"\n"flui_pooler_admin" "adminpw"\n',
    );
  });

  it('rolls the pooler pod when its configuration changes', () => {
    const hashOf = (spec: PoolerSpec) =>
      docs(database({ pooler: spec })).find((d) => d.kind === 'Deployment')!
        .spec.template.metadata.annotations['flui.cloud/pooler-config-hash'];
    expect(hashOf(pooler)).not.toBe(hashOf({ ...pooler, mode: 'session' }));
  });

  it('keeps the upstream Service on the address it was given', () => {
    const upstream = docs(
      database({ pooler: { ...pooler, upstreamClusterIP: '10.43.7.9' } }),
    ).find((d) => d.metadata.name === 'postgresql-ab12-pooler-upstream')!;
    expect(upstream.spec.clusterIP).toBe('10.43.7.9');
  });

  it('forwards through a Service without a selector and an EndpointSlice to the remote address', () => {
    const all = docs(
      database({
        pooler: {
          ...pooler,
          upstream: {
            mode: 'forward',
            address: '10.200.0.5',
            port: 15432,
            linkId: 'link-1',
          },
        },
      }),
    );
    const upstream = all.find(
      (d) => d.metadata.name === 'postgresql-ab12-pooler-upstream',
    )!;
    expect(upstream.spec.selector).toBeUndefined();
    const slice = all.find((d) => d.kind === 'EndpointSlice')!;
    expect(slice.metadata.name).toBe('postgresql-ab12-pooler-upstream-fwd');
    expect(slice.metadata.labels['kubernetes.io/service-name']).toBe(
      'postgresql-ab12-pooler-upstream',
    );
    expect(slice.endpoints).toEqual([
      { addresses: ['10.200.0.5'], conditions: { ready: true } },
    ]);
    expect(slice.ports).toEqual([
      { name: 'postgres', port: 15432, protocol: 'TCP' },
    ]);
  });

  it("leaves the database's own manifests exactly as they are", () => {
    const without = generator.generateForDockerImage(database());
    const withPooler = generator.generateForDockerImage(database({ pooler }));
    expect(withPooler.map((m) => [m.kind, m.name, m.yaml])).toEqual(
      without.map((m) => [m.kind, m.name, m.yaml]),
    );
  });
});
