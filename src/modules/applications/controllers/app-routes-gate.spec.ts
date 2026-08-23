jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { AppManagementController } from './app-management.controller';
import { ApplicationsController } from './applications.controller';
import { ApplicationSnapshotsController } from './application-snapshots.controller';
import { AppAccessGuard } from '../guards/app-access.guard';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';

const caller: AuthenticatedUser = {
  userId: 'user-a',
  email: 'a@example.com',
  roles: {},
  role: IdentityRole.USER,
  isAdmin: false,
};

const req = { user: caller } as never;

/**
 * `AppManagementController` mounts no guard of its own for its whole life, so
 * `PATCH replicas`, `PATCH resources`, `POST restart` and `GET runtime`
 * answered every valid token — proved from the wire in section 11, where one
 * principal scaled another's application and was stopped only by Kubernetes not
 * finding the Deployment. The mark is one line, which is exactly why its
 * absence went unnoticed; this pins it.
 */
describe('AppManagementController is behind the per-application guard', () => {
  it('carries AppAccessGuard at class level', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      AppManagementController,
    ) as unknown[];
    expect(guards).toContain(AppAccessGuard);
  });

  it('names its application :appId, which the guard reads', () => {
    const path = Reflect.getMetadata('path', AppManagementController) as string;
    expect(path).toBe('applications/:appId');
  });
});

/**
 * Two things the routes of ApplicationsController were dropping on the floor:
 * the address of every application it lists, and the person behind every
 * deploy it starts.
 */
describe('ApplicationsController fills in what it used to drop', () => {
  const build = () => {
    const calls: Record<string, unknown[]> = {
      toResponseDtosWithUrls: [],
      deploy: [],
    };
    const apps = {
      findByClusterId: jest.fn().mockResolvedValue([{ id: 'app-1' }]),
      toResponseDto: jest.fn((a: { id: string }) => ({ id: a.id })),
      toResponseDtosWithUrls: jest.fn((entities: { id: string }[]) => {
        calls.toResponseDtosWithUrls.push(entities);
        return Promise.resolve(
          entities.map((e) => ({ id: e.id, url: `https://${e.id}.example` })),
        );
      }),
      findById: jest.fn(async (id: string) => ({ id, k8sNamespace: 'ns' })),
      create: jest.fn(async () => ({ id: 'app-1', k8sNamespace: 'ns' })),
    };
    const access = {
      filterReadable: jest.fn(async (_u: unknown, list: unknown[]) => list),
      summarise: jest
        .fn()
        .mockResolvedValue(new Map([['app-1', { readOnly: false }]])),
      assertCanCreate: jest.fn().mockResolvedValue({ isSandbox: false }),
    };
    const deploys = {
      deploy: jest.fn((...args: unknown[]) => {
        calls.deploy.push(args);
        return Promise.resolve({
          id: 'op-1',
          status: 'PENDING',
          totalSteps: 1,
          operationType: 'deploy_application',
        });
      }),
    };
    const revisions = { createAuditEvent: jest.fn().mockResolvedValue(null) };
    const snapshots = {
      createForApp: jest.fn().mockResolvedValue({}),
      deleteForApp: jest.fn().mockResolvedValue({}),
      restoreForApp: jest.fn().mockResolvedValue({}),
    };
    const management = { swapVolumeClaim: jest.fn().mockResolvedValue({}) };
    const controller = new ApplicationsController(
      access as never,
      apps as never,
      deploys as never,
      undefined as never,
      { reconcileByClusterId: jest.fn() } as never,
      revisions as never,
      undefined as never,
      undefined as never,
      undefined as never,
      management as never,
      undefined as never,
    );
    // Snapshots, backups and the volume swap moved out of the 1027-line
    // controller in round E2; the routes and their bodies are the same, so the
    // assertions below simply follow them to their new class.
    const snapshotsController = new ApplicationSnapshotsController(
      snapshots as never,
      undefined as never,
      management as never,
    );
    return {
      controller,
      snapshotsController,
      apps,
      access,
      deploys,
      snapshots,
      management,
      calls,
    };
  };

  it('lists applications with their real address, and keeps the access summary', async () => {
    const { controller, apps } = build();
    const rows = await controller.listByCluster(req, 'cluster-1');
    expect(apps.toResponseDtosWithUrls).toHaveBeenCalledTimes(1);
    expect(apps.toResponseDto).not.toHaveBeenCalled();
    expect(rows).toEqual([
      {
        id: 'app-1',
        url: 'https://app-1.example',
        access: { readOnly: false },
      },
    ]);
  });

  it('enriches only what the caller may read', async () => {
    const { controller, access, calls } = build();
    access.filterReadable.mockResolvedValue([]);
    await controller.listByCluster(req, 'cluster-1');
    expect(calls.toResponseDtosWithUrls).toEqual([[]]);
  });

  it('passes the caller to an explicit deploy', async () => {
    const { controller, calls } = build();
    await controller.deploy(req, 'app-1', {} as never);
    expect(calls.deploy).toEqual([['app-1', {}, 'user-a']]);
  });

  /**
   * The operations these four routes start are read back through
   * `GET /infrastructure/operations/:id`, which now asks who owns them. An
   * operation created with no owner is nobody's, so it becomes unreadable to
   * the very person who started it — which is how "record the author" and
   * "ask whose it is" turned out to be one change, not two.
   */
  it('records the caller on every snapshot operation it starts', async () => {
    const { snapshotsController, snapshots } = build();
    await snapshotsController.createSnapshot(req, 'app-1', {});
    await snapshotsController.deleteSnapshot(req, 'app-1', 'snap-1');
    await snapshotsController.restoreSnapshot(req, 'app-1', 'snap-1');
    expect(snapshots.createForApp).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: 'app-1', userId: 'user-a' }),
    );
    expect(snapshots.deleteForApp).toHaveBeenCalledWith(
      'app-1',
      'snap-1',
      'user-a',
    );
    expect(snapshots.restoreForApp).toHaveBeenCalledWith(
      'app-1',
      'snap-1',
      'user-a',
    );
  });

  it('records the caller on a volume swap too', async () => {
    const { snapshotsController, management } = build();
    await snapshotsController.swapVolume(req, 'app-1', 'data', {
      newClaimName: 'pvc-2',
    });
    expect(management.swapVolumeClaim).toHaveBeenCalledWith(
      'app-1',
      'data',
      'pvc-2',
      'user-a',
    );
  });

  it('passes the caller to the auto-deploy inside create', async () => {
    const { controller, calls } = build();
    await controller.create(
      'cluster-1',
      { autoDeploy: true, sourceType: 'docker_image' } as never,
      req,
    );
    expect(calls.deploy).toEqual([['app-1', {}, 'user-a']]);
  });
});
