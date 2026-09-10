jest.mock('@kubernetes/client-node', () => ({}));

import { AttachedServicesResolverService } from './attached-services-resolver.service';
import { AttachedServiceStatus } from '../entities/application-service.entity';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';
import { CatalogAppType } from '../../catalog/enums/catalog-app-type.enum';
import { CONNECTION_URL_KEY } from '../connection-url.core';

/**
 * The four questions that decide whether this is a feature or a way to leave a
 * 10Gi volume behind on every push: does it install when nothing is there, does
 * it reuse what is, does it stay quiet on a redeploy, and does it refuse to go
 * on when the block never comes up.
 */
describe('AttachedServicesResolverService', () => {
  const CLUSTER = 'cluster-1';
  const APP = 'app-1';

  const postgresDefinition = {
    id: 'def-postgres',
    slug: 'postgresql',
    appType: CatalogAppType.BUILDING_BLOCK,
    manifest: {
      spec: {
        engine: 'postgres',
        ports: [{ internal: 5432 }],
        env: [
          {
            name: 'POSTGRES_PASSWORD',
            valueFrom: { generate: { length: 24 } },
          },
          { name: 'POSTGRES_USER', value: 'flui' },
        ],
      },
    },
  };

  function makeHarness(opts?: {
    installStatuses?: CatalogInstallStatus[];
    existingRow?: Record<string, any>;
  }) {
    const statuses = [
      ...(opts?.installStatuses ?? [CatalogInstallStatus.RUNNING]),
    ];

    const row: Record<string, any> = opts?.existingRow ?? {
      id: 'row-1',
      applicationId: APP,
      name: 'db',
      block: 'postgresql',
      status: AttachedServiceStatus.PENDING,
      statusReason: null,
      catalogInstallId: null,
      bbApplicationId: null,
      envSpec: [],
      resources: null,
      desiredHash: '',
      appliedHash: null,
    };

    const installs = new Map<string, any>();
    if (row.catalogInstallId) {
      installs.set(row.catalogInstallId, {
        id: row.catalogInstallId,
        clusterId: CLUSTER,
        status: CatalogInstallStatus.RUNNING,
        applicationIds: ['bb-app-1'],
        catalogAppDefinitionId: 'def-postgres',
      });
    }

    const installBuildingBlock = jest.fn(async () => {
      const install = {
        id: 'install-new',
        clusterId: CLUSTER,
        status: statuses[0],
        applicationIds: ['bb-app-1'],
        catalogAppDefinitionId: 'def-postgres',
        errorMessage: null as string | null,
      };
      installs.set(install.id, install);
      return { install, operation: { id: 'op-1' } };
    });

    let poll = 0;
    const installRepo = {
      findById: jest.fn(async (id: string) => {
        const install = installs.get(id);
        if (!install) return null;
        if (id === 'install-new' && statuses.length) {
          install.status = statuses[Math.min(poll, statuses.length - 1)];
          poll += 1;
        }
        return install;
      }),
    };

    const rows = {
      listByApplication: jest.fn(async () => [row]),
      upsertDesired: jest.fn(async (_appId: string, desired: any) => {
        row.block = desired.block;
        row.envSpec = desired.envSpec;
        row.resources = desired.resources;
        return row;
      }),
      acquireLock: jest.fn(async () => 'token-1'),
      releaseLock: jest.fn(async () => undefined),
      markReady: jest.fn(async (_id: string, patch: any) => {
        Object.assign(row, patch, { status: AttachedServiceStatus.READY });
      }),
      markFailed: jest.fn(async (_id: string, reason: string) => {
        row.status = AttachedServiceStatus.FAILED;
        row.statusReason = reason;
      }),
      markDetached: jest.fn(async () => undefined),
      retire: jest.fn(async () => undefined),
    };

    const blockApp = {
      id: 'bb-app-1',
      slug: 'flui-postgres-a1b2',
      k8sNamespace: 'user-x',
      port: 5432,
      env: [{ name: 'POSTGRES_USER', value: 'flui' }],
      labels: {},
    };

    const applicationsRepo = {
      findById: jest.fn(async (id: string) =>
        id === 'bb-app-1' ? blockApp : { id: APP, userId: 'u1' },
      ),
      update: jest.fn(async () => undefined),
    };

    const definitionRepo = {
      findActiveBySlug: jest.fn(async (slug: string) =>
        slug === 'postgresql' ? postgresDefinition : null,
      ),
      findById: jest.fn(async () => postgresDefinition),
    };

    const blockConnectionUrl = {
      ensureOnExisting: jest.fn(async () => CONNECTION_URL_KEY),
    };

    const users = { findOne: jest.fn(async () => ({ email: 'a@b.c' })) };

    const service = new AttachedServicesResolverService(
      rows as any,
      applicationsRepo as any,
      { installBuildingBlock, uninstall: jest.fn() } as any,
      installRepo as any,
      definitionRepo as any,
      blockConnectionUrl as any,
      users as any,
    );

    return {
      service,
      rows,
      row,
      installBuildingBlock,
      installRepo,
      applicationsRepo,
      blockConnectionUrl,
    };
  }

  const dbService = {
    name: 'db',
    block: 'postgresql',
    env: [
      { name: 'DATABASE_URL', fromService: 'url' as const },
      { name: 'DB_HOST', fromService: 'host' as const },
    ],
  };

  const ctx = {
    applicationId: APP,
    clusterId: CLUSTER,
    userId: 'u1',
    userEmail: 'a@b.c',
    waitTimeoutMs: 200,
    pollIntervalMs: 1,
  };

  it('installs the block when the application owns none, and wires its env', async () => {
    const h = makeHarness();

    const result = await h.service.reconcile({ ...ctx, services: [dbService] });

    expect(h.installBuildingBlock).toHaveBeenCalledTimes(1);
    expect(h.installBuildingBlock).toHaveBeenCalledWith(
      'postgresql',
      CLUSTER,
      'u1',
      'a@b.c',
    );
    expect(result.env).toEqual([
      {
        name: 'DATABASE_URL',
        value: '',
        secret: true,
        externalSecretRef: {
          secretName: 'flui-postgres-a1b2-secret',
          key: CONNECTION_URL_KEY,
        },
      },
      {
        name: 'DB_HOST',
        value: 'flui-postgres-a1b2-svc.user-x.svc.cluster.local',
        secret: false,
      },
    ]);
    expect(result.attachments).toEqual([
      expect.objectContaining({
        name: 'db',
        block: 'postgresql',
        status: AttachedServiceStatus.READY,
        catalogInstallId: 'install-new',
        bbApplicationId: 'bb-app-1',
      }),
    ]);
    expect(h.rows.markReady).toHaveBeenCalled();
  });

  it('reuses the instance the row already points at', async () => {
    const h = makeHarness({
      existingRow: {
        id: 'row-1',
        applicationId: APP,
        name: 'db',
        block: 'postgresql',
        status: AttachedServiceStatus.READY,
        statusReason: null,
        catalogInstallId: 'install-existing',
        bbApplicationId: 'bb-app-1',
        envSpec: dbService.env,
        resources: null,
        desiredHash: 'h',
        appliedHash: 'h',
      },
    });

    const result = await h.service.reconcile({ ...ctx, services: [dbService] });

    expect(h.installBuildingBlock).not.toHaveBeenCalled();
    expect(result.attachments[0].catalogInstallId).toBe('install-existing');
    expect(result.env).toHaveLength(2);
  });

  it('does not install a second block when the same manifest is deployed again', async () => {
    const h = makeHarness();

    await h.service.reconcile({ ...ctx, services: [dbService] });
    expect(h.installBuildingBlock).toHaveBeenCalledTimes(1);

    // Second push, same manifest: the row now points at the install made above.
    await h.service.reconcile({ ...ctx, services: [dbService] });
    expect(h.installBuildingBlock).toHaveBeenCalledTimes(1);
  });

  it('fails the deploy — and records why — when the block never reaches RUNNING', async () => {
    const h = makeHarness({
      installStatuses: [CatalogInstallStatus.PENDING],
    });

    await expect(
      h.service.reconcile({ ...ctx, services: [dbService] }),
    ).rejects.toThrow(/did not reach RUNNING/);

    expect(h.rows.markFailed).toHaveBeenCalledWith(
      'row-1',
      expect.stringContaining('did not reach RUNNING'),
    );
    expect(h.rows.releaseLock).toHaveBeenCalledWith('row-1', 'token-1');
  });

  it('propagates a failed install instead of waiting out the timeout', async () => {
    const h = makeHarness({
      installStatuses: [CatalogInstallStatus.FAILED],
    });

    await expect(
      h.service.reconcile({ ...ctx, services: [dbService] }),
    ).rejects.toThrow(/failed/);
  });

  it('refuses to start when another deploy holds the row', async () => {
    const h = makeHarness();
    h.rows.acquireLock.mockResolvedValueOnce(null as any);

    await expect(
      h.service.reconcile({ ...ctx, services: [dbService] }),
    ).rejects.toThrow(/already being provisioned/);
    expect(h.installBuildingBlock).not.toHaveBeenCalled();
  });

  it('stamps the block with who attached it', async () => {
    const h = makeHarness();

    await h.service.reconcile({ ...ctx, services: [dbService] });

    expect(h.applicationsRepo.update).toHaveBeenCalledWith('bb-app-1', {
      labels: {
        'flui.cloud/attached-to': APP,
        'flui.cloud/attached-as': 'db',
      },
    });
  });

  it('leaves a FAILED row behind when the manifest is refused, so the deploy gate can see it', async () => {
    // The regression this guards: `validate` ran before any row was written, so a refusal threw
    // with nothing recorded. On the push path that is a 500 to the Action and no more — the image
    // is already registered, and the next Deploy press reaches `assertAttachedServicesReady`,
    // finds no row that is not READY because there is no row at all, and lets the application
    // through GREEN without the service its own manifest declares.
    const h = makeHarness();

    await expect(
      h.service.reconcile({
        ...ctx,
        services: [{ name: 'db', block: 'nope', env: [] }],
      }),
    ).rejects.toThrow(/no catalog block called "nope"/);

    expect(h.rows.upsertDesired).toHaveBeenCalledWith(APP, expect.anything());
    expect(h.rows.markFailed).toHaveBeenCalledWith(
      h.row.id,
      expect.stringMatching(/no catalog block/),
    );
  });

  describe('validate', () => {
    it('refuses a block that does not exist', async () => {
      const h = makeHarness();
      await expect(
        h.service.validate([{ name: 'db', block: 'nope', env: [] }]),
      ).rejects.toThrow(/no catalog block called "nope"/);
    });

    it('refuses the reserved name', async () => {
      const h = makeHarness();
      await expect(
        h.service.validate([{ name: 'app', block: 'postgresql', env: [] }]),
      ).rejects.toThrow(/reserved/);
    });

    it('refuses two services with one name', async () => {
      const h = makeHarness();
      await expect(
        h.service.validate([
          { name: 'db', block: 'postgresql', env: [] },
          { name: 'db', block: 'postgresql', env: [] },
        ]),
      ).rejects.toThrow(/two services are called "db"/);
    });

    it('refuses a fromBBEnv the block does not declare', async () => {
      const h = makeHarness();
      await expect(
        h.service.validate([
          {
            name: 'db',
            block: 'postgresql',
            env: [{ name: 'X', fromBBEnv: 'NOPE' }],
          },
        ]),
      ).rejects.toThrow(/not a variable "postgresql" declares/);
    });

    it('refuses url on a block with no engine, naming the alternative', async () => {
      const h = makeHarness();
      const noEngine = {
        ...postgresDefinition,
        manifest: {
          spec: { ...postgresDefinition.manifest.spec, engine: undefined },
        },
      };
      (h.service as any).definitionRepo.findActiveBySlug = jest.fn(
        async () => noEngine,
      );
      await expect(
        h.service.validate([
          {
            name: 'q',
            block: 'postgresql',
            env: [{ name: 'URL', fromService: 'url' }],
          },
        ]),
      ).rejects.toThrow(/fromService: host \/ port/);
    });
  });

  describe('collidingEnvNames', () => {
    it('names every key both lists declare', () => {
      const h = makeHarness();
      expect(
        h.service.collidingEnvNames([dbService], ['DB_HOST', 'PORT']),
      ).toEqual(['DB_HOST']);
    });
  });
});
