jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { load } from 'js-yaml';
import { ApplicationMaterializerService } from './application-materializer.service';
import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';

/**
 * After the DB promote of a live-fenced full migration the consumer already
 * runs on the destination with the rewired env. Re-applying it costs a full
 * apply-and-wait inside the write pause; this is the check that lets the
 * orchestrator skip it, decided on the generator's own change detector.
 */
const encryption = {
  encrypt: (v: string) => `enc(${v})`,
  decrypt: (v: string) => v.replace(/^enc\((.*)\)$/, '$1'),
} as unknown as EncryptionService;
const generator = new ApplicationManifestGeneratorService(encryption);

const source: ApplicationEntity = {
  id: 'app-1',
  slug: 'shop',
  name: 'shop',
  k8sNamespace: 'proj',
  replicas: 2,
  env: [
    { name: 'PORT', value: '8080', secret: false, source: 'user' },
    {
      name: 'DATABASE_URL',
      value: 'enc(postgres://u:p@db-a-svc:5432/app)',
      secret: true,
      source: 'user',
    },
  ],
  sourceConfig: { imageRef: 'ghcr.io/acme/shop:1.4.0' },
} as unknown as ApplicationEntity;

const rewiredEnv = [
  { name: 'PORT', value: '8080', secret: false, source: 'user' },
  {
    name: 'DATABASE_URL',
    value: 'enc(postgres://u:p@db-b-svc:5432/app)',
    secret: true,
  },
];

function liveDeploymentOf(app: ApplicationEntity, ready = true): any {
  const yaml = generator
    .generateForDockerImage(app)
    .find((m) => m.kind === 'Deployment')!.yaml;
  const deployment = load(yaml) as any;
  const replicas = deployment.spec.replicas;
  return {
    ...deployment,
    metadata: { ...deployment.metadata, generation: 3 },
    status: {
      observedGeneration: 3,
      replicas,
      updatedReplicas: replicas,
      readyReplicas: ready ? replicas : 0,
      availableReplicas: ready ? replicas : 0,
    },
  };
}

function materializerWith(live: unknown) {
  const kube = { getResource: jest.fn(async () => live) };
  const service = new ApplicationMaterializerService(
    {
      findOne: jest.fn(async () => ({ id: 'B', kubeconfigEncrypted: 'kc' })),
    } as never,
    kube as never,
    encryption,
    generator,
    {} as never,
    {} as never,
  );
  return { service, kube };
}

const staged = { ...source, env: rewiredEnv } as ApplicationEntity;
const rewiredFromDb = {
  ...source,
  env: JSON.parse(JSON.stringify(rewiredEnv)),
} as ApplicationEntity;

describe('ApplicationMaterializerService.isCurrentOnCluster', () => {
  it('sees the live-fenced staging as current for the rewired app read back from the database', async () => {
    const { service } = materializerWith(liveDeploymentOf(staged));

    await expect(service.isCurrentOnCluster(rewiredFromDb, 'B')).resolves.toBe(
      true,
    );
  });

  it('is not current when the env differs from what the pods run', async () => {
    const { service } = materializerWith(liveDeploymentOf(source));

    await expect(service.isCurrentOnCluster(rewiredFromDb, 'B')).resolves.toBe(
      false,
    );
  });

  it('is not current while the pods are not ready', async () => {
    const { service } = materializerWith(liveDeploymentOf(staged, false));

    await expect(service.isCurrentOnCluster(rewiredFromDb, 'B')).resolves.toBe(
      false,
    );
  });

  it('is not current when the replica count differs', async () => {
    const { service } = materializerWith(
      liveDeploymentOf({ ...staged, replicas: 1 } as ApplicationEntity),
    );

    await expect(service.isCurrentOnCluster(rewiredFromDb, 'B')).resolves.toBe(
      false,
    );
  });

  it('is not current when there is no workload', async () => {
    const { service } = materializerWith(null);

    await expect(service.isCurrentOnCluster(rewiredFromDb, 'B')).resolves.toBe(
      false,
    );
  });
});
