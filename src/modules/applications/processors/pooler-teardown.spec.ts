jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { ApplicationTeardownService } from './application-teardown.service';
import { ApplicationMaterializerService } from '../services/application-materializer.service';
import { ApplicationManifestGeneratorService } from '../services/application-manifest-generator.service';

/**
 * A pooler is never among the database's tracked resources and never carries
 * `flui-app-id`, so neither the tracked-resource loop nor the label sweep of a
 * delete could see it. Both teardowns find it by `flui.cloud/pooler-of`.
 */
const app = {
  id: 'db-1',
  slug: 'postgresql-ab12',
  name: 'postgresql-ab12',
  clusterId: 'c1',
  k8sNamespace: 'user-x',
  env: [],
  sourceConfig: { type: 'docker_image', imageRef: 'postgres:17' },
};

function cluster() {
  const deleted: string[] = [];
  const kubernetes = {
    listResourcesByLabel: jest.fn(
      async (_kc: string, kind: string, _ns: string, selector: string) =>
        selector === 'flui.cloud/pooler-of=db-1'
          ? ({
              Deployment: [{ metadata: { name: 'postgresql-ab12-pooler' } }],
              Service: [
                { metadata: { name: 'postgresql-ab12-pooler' } },
                { metadata: { name: 'postgresql-ab12-pooler-upstream' } },
              ],
              Secret: [{ metadata: { name: 'postgresql-ab12-pooler' } }],
            }[kind] ?? [])
          : [],
    ),
    deleteResource: jest.fn(async (_kc: string, kind: string, name: string) => {
      deleted.push(`${kind}/${name}`);
    }),
  };
  return { kubernetes, deleted };
}

const poolerObjects = [
  'Deployment/postgresql-ab12-pooler',
  'Service/postgresql-ab12-pooler',
  'Service/postgresql-ab12-pooler-upstream',
  'Secret/postgresql-ab12-pooler',
];

describe('the pooler goes with its database', () => {
  it('is removed when the database is deleted', async () => {
    const { kubernetes, deleted } = cluster();
    const self = Object.create(ApplicationTeardownService.prototype);
    Object.assign(self, {
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      kubernetesService: kubernetes,
      encryptionService: { decrypt: (v: string) => v },
      eventsGateway: {
        emitOperationProgress: () => {},
        emitOperationCompleted: () => {},
      },
      updateOperation: jest.fn(),
      sweepOrphanResources: jest.fn(),
      applicationsRepository: {
        findById: jest.fn(async () => app),
        softDelete: jest.fn(),
      },
      clusterRepository: {
        findOne: jest.fn(async () => ({ id: 'c1', kubeconfigEncrypted: 'kc' })),
        manager: { find: jest.fn(async () => []) },
      },
      appResourcesRepository: {
        findByApplicationId: jest.fn(async () => []),
        deleteByApplicationId: jest.fn(),
      },
      appRevisionsRepository: { createAuditEvent: jest.fn() },
      registry: { forgetApplication: jest.fn(async () => undefined) },
      backupPolicies: {
        find: jest.fn(async () => []),
        update: jest.fn(),
      },
    });

    await self.handleDelete({
      id: 'job-1',
      name: 'delete-application',
      attemptsMade: 0,
      data: { operationId: 'op-1', applicationId: 'db-1' },
    });

    expect(deleted.sort()).toEqual([...poolerObjects].sort());
  });

  it('is removed when a migration tears the database down on a cluster', async () => {
    const { kubernetes, deleted } = cluster();
    const materializer = new ApplicationMaterializerService(
      {
        findOne: jest.fn(async () => ({ kubeconfigEncrypted: 'kc' })),
      } as never,
      kubernetes as never,
      { decrypt: (v: string) => v } as never,
      new ApplicationManifestGeneratorService({
        decrypt: (v: string) => v,
      } as never),
      null as never,
      null as never,
    );

    await materializer.teardownOnCluster(app as never, 'c2');

    expect(deleted).toEqual(expect.arrayContaining(poolerObjects));
  });
});
