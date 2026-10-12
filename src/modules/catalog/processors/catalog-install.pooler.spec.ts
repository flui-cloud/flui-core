// Same reason as the sibling specs: the processor's import graph reaches
// ESM-only packages ts-jest cannot transform.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { CatalogInstallProcessor } from './catalog-install.processor';
import { CatalogSchemaValidatorService } from '../services/catalog-schema-validator.service';
import { OperationStatus } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';

const manifest = new CatalogSchemaValidatorService().validate(
  load(
    readFileSync(join(__dirname, '..', 'seed', 'postgresql.flui.yaml'), 'utf8'),
  ),
);

/**
 * The single-application install path, run for real against stand-ins for
 * everything it talks to. What is under test is the order and the data: the
 * pooler is written on the row before the database's first deploy, and the
 * move onto it is left to that deploy, which brings the pooler up once the
 * database is ready.
 */
function run(options: Record<string, boolean>, existing: unknown[] = []) {
  const calls: string[] = [];
  const app: Record<string, any> = {
    id: 'app-1',
    name: 'postgresql-ab12',
    slug: 'postgresql-ab12',
    env: [],
  };
  const self = Object.create(CatalogInstallProcessor.prototype);
  Object.assign(self, {
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    operationRepo: {
      update: jest.fn(),
      findOne: jest.fn(async () => ({ status: OperationStatus.COMPLETED })),
    },
    installRepo: {
      updateStatus: jest.fn(),
      update: jest.fn(),
      findById: jest.fn(async () => ({
        id: 'install-1',
        slug: 'postgresql-ab12',
        clusterId: 'c1',
        catalogAppDefinitionId: 'def-1',
        userId: 'u1',
        options,
        envOverrides: {},
        userInputs: {},
        dependencyChoices: [],
      })),
    },
    definitionRepo: {
      findById: jest.fn(async () => ({
        id: 'def-1',
        slug: 'postgresql',
        appType: manifest.spec.type,
        version: '17',
        manifest,
      })),
    },
    projects: {
      placementFor: jest.fn(async () => ({
        project: { id: 'p1' },
        namespace: 'user-x',
      })),
    },
    sandboxTenants: { exists: jest.fn(async () => false) },
    secretGenerator: { generate: () => 'generated' },
    templateResolver: { resolve: (v: string) => v },
    applicationRepo: {
      findByCatalogInstall: jest.fn(async () => existing),
      findById: jest.fn(async () => ({ status: ApplicationStatus.RUNNING })),
      update: jest.fn(async (_id: string, data: Record<string, unknown>) => {
        if ('pooler' in data) calls.push('pooler written');
      }),
    },
    applicationService: {
      create: jest.fn(async () => app),
    },
    blockConnectionUrl: {
      ensureAtGeneration: jest.fn(async () => calls.push('urls composed')),
    },
    deployService: {
      triggerDeployWithImage: jest.fn(async () => {
        calls.push('deploy');
        return { id: 'deploy-op' };
      }),
    },
    deployConfig: {
      getCatalogInstallWaitTimeoutMs: () => 1000,
      getCatalogInstallPollIntervalMs: () => 1,
    },
    poolers: {
      newSpec: jest.fn((mode: string) => ({ enabled: true, mode })),
      bringUp: jest.fn(async () => {
        calls.push('pooler brought up');
        return { routed: true, reason: null };
      }),
    },
  });
  return {
    app,
    calls,
    self,
    done: self.handleInstall({
      data: { installId: 'install-1', operationId: 'op-1' },
    }),
  };
}

describe('a PostgreSQL install and its pooler', () => {
  it('writes a transaction-mode pooler before the first deploy and leaves routing to the deploy', async () => {
    const { app, calls, self, done } = run({
      pooler: true,
      poolerSessionMode: false,
    });
    await done;
    expect(app.pooler).toEqual({ enabled: true, mode: 'transaction' });
    expect(calls).toEqual(['pooler written', 'urls composed', 'deploy']);
    expect(self.poolers.bringUp).not.toHaveBeenCalled();
  });

  it('writes the session mode the install chose', async () => {
    const { app, done } = run({ pooler: true, poolerSessionMode: true });
    await done;
    expect(app.pooler).toEqual({ enabled: true, mode: 'session' });
  });

  it('gives a database installed without the pooler none at all', async () => {
    const { app, calls, self, done } = run({
      pooler: false,
      poolerSessionMode: false,
    });
    await done;
    expect(app.pooler).toBeUndefined();
    expect(calls).toEqual(['urls composed', 'deploy']);
    expect(self.poolers.bringUp).not.toHaveBeenCalled();
  });

  it('never adds a pooler to an application a previous run already created', async () => {
    const earlier = {
      id: 'app-1',
      name: 'postgresql-ab12',
      slug: 'postgresql-ab12',
      env: [],
      pooler: null,
    };
    const { calls, self, done } = run({}, [earlier]);
    await done;
    expect(calls).not.toContain('pooler written');
    expect(self.poolers.bringUp).not.toHaveBeenCalled();
  });
});
