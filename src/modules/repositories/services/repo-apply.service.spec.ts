// `RepoApplyService` is decorated, so TS emits real imports of everything its
// constructor names — which reaches the token resolver's ESM-only `@octokit`
// chain and the Kubernetes client. Stubbed the way the sibling specs do.
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('@kubernetes/client-node', () => ({}));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  RepoApplyService,
  STRANDED_APPLY_KEY,
  manifestPathFor,
} from './repo-apply.service';
import type { RepoMapService } from './repo-map.service';
import type { GitHubWorkflowService } from './github-workflow.service';
import type { WorkflowGeneratorService } from './workflow-generator.service';
import type { RepositoryMapResponseDto } from '../dto/repository-map.dto';
import type { ApplicationSourceDeployService } from '../../applications/services/application-source-deploy.service';
import type { ApplicationWorkflowService } from '../../applications/services/application-workflow.service';
import type { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';
import { WorkflowGeneratorService as RealWorkflowGenerator } from './workflow-generator.service';

const BASE_SHA = '3f9a2c1eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const HEAD = 'flui/deploy-3f9a2c1';
const COMMIT_SHA = '9999999999999999999999999999999999999999';

const REQUEST = {
  repositoryId: 'repo-uuid',
  owner: 'acme',
  repo: 'shop',
  branch: 'main',
  clusterId: 'cluster-uuid',
  isSandboxGuest: false,
};

function mapOf(
  overrides: Partial<{
    ok: boolean;
    reason: string;
    outcome: string;
    units: Array<{ unitId: string; name: string; yaml: string }>;
    skipped: Array<{ unitId: string; reason: string }>;
    /** Per-unit readiness. Defaults to `deployable` for every rendered unit: the apply reads this,
     * not the render, to decide what is worth someone's Actions minutes. */
    readiness: Record<string, string>;
  }> = {},
): RepositoryMapResponseDto {
  const ok = overrides.ok ?? true;
  const units = overrides.units ?? [
    {
      unitId: '.',
      name: 'shop',
      yaml: 'kind: Application\nmetadata:\n  name: shop\n',
    },
  ];
  return {
    repositoryId: REQUEST.repositoryId,
    repoFullName: 'acme/shop',
    branch: 'main',
    read: ok
      ? ({ ok: true, commitSha: BASE_SHA } as any)
      : ({ ok: false, reason: overrides.reason ?? 'not-found' } as any),
    map: null,
    verdict: {
      outcome: (overrides.outcome ?? 'deployable') as any,
      reason: 'every unit renders and the cluster has room.',
      remedy: null,
      evidence: [],
      units: units.map((u) => ({
        id: u.unitId,
        readiness: (overrides.readiness?.[u.unitId] ?? 'deployable') as any,
        reason: '',
        remedy: null,
        evidence: [],
      })),
      capacity: {} as any,
    },
    render: ok
      ? ({
          units: units.map((u) => ({ ...u, manifest: {} as any })),
          skipped: overrides.skipped ?? [],
          notes: [],
        } as any)
      : null,
  } as RepositoryMapResponseDto;
}

function preparedApp(
  id: string,
  slug: string,
  name: string,
  subPath?: string,
  extra?: {
    /** `name=block` of everything the preparation already provisioned. */
    attachedServices?: string[];
    metadata?: Record<string, string>;
    /** The row's env as `prepareApplicationFromYaml` left it. */
    env?: Array<{ name: string; pending?: boolean; secret?: boolean }>;
  },
) {
  return {
    app: {
      id,
      slug,
      name,
      sourceConfig: { type: 'git_build' },
      metadata: extra?.metadata ?? {},
      env: extra?.env,
    },
    manifest: { build: {} },
    branch: HEAD,
    repositoryId: REQUEST.repositoryId,
    buildPaths: {
      dockerfile: subPath ? `${subPath}/Dockerfile` : 'Dockerfile',
      context: subPath ?? '.',
      subPath,
    },
    skipBuild: false,
    resolvedImageRef: null,
    attachedServices: extra?.attachedServices ?? [],
    adopted: false,
  } as any;
}

function serviceUnder(
  o: {
    map?: RepositoryMapResponseDto;
    createBranchFrom?: jest.Mock;
    commitFilesOnBranch?: jest.Mock;
    deleteBranch?: jest.Mock;
    prepare?: jest.Mock;
    saveWebhookSecret?: jest.Mock;
    markAwaitingExternalBuild?: jest.Mock;
    findById?: jest.Mock;
    attachmentsOf?: jest.Mock;
    findWebhookTokenForRepository?: jest.Mock;
    /** The cluster's applications, as the stranded-application lookup sees them. */
    findByClusterId?: jest.Mock;
    updateApplication?: jest.Mock;
  } = {},
) {
  const github = {
    createBranchFrom:
      o.createBranchFrom ??
      jest.fn().mockResolvedValue({ head: HEAD, baseSha: BASE_SHA }),
    commitFilesOnBranch:
      o.commitFilesOnBranch ??
      jest.fn().mockImplementation((_u, _o2, _r, _b, files) =>
        Promise.resolve({
          sha: COMMIT_SHA,
          baseSha: BASE_SHA,
          workflowUrl: '',
          files: files.map((f: { path: string }) => f.path),
        }),
      ),
    deleteBranch: o.deleteBranch ?? jest.fn().mockResolvedValue(true),
  } as unknown as GitHubWorkflowService;

  const workflow = {
    isBackendPollingOnly: jest.fn().mockReturnValue(false),
    saveWebhookSecret:
      o.saveWebhookSecret ?? jest.fn().mockResolvedValue(undefined),
    saveFluiGhcrSecret: jest.fn().mockResolvedValue(true),
    markAwaitingExternalBuild:
      o.markAwaitingExternalBuild ??
      jest.fn().mockResolvedValue({ runId: '42' }),
  } as unknown as ApplicationWorkflowService;

  const prepare =
    o.prepare ??
    jest.fn().mockResolvedValue(preparedApp('app-1', 'shop-ab12cd', 'shop'));

  const applications = {
    findWebhookTokenForRepository:
      o.findWebhookTokenForRepository ?? jest.fn().mockResolvedValue(null),
    findByClusterId: o.findByClusterId ?? jest.fn().mockResolvedValue([]),
    findById: o.findById ?? jest.fn().mockResolvedValue(null),
    update: o.updateApplication ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as ApplicationsRepository;

  const attached = {
    attachmentsOf: o.attachmentsOf ?? jest.fn().mockResolvedValue([]),
  } as any;

  const service = new RepoApplyService(
    {
      mapFor: jest.fn().mockResolvedValue(o.map ?? mapOf()),
    } as unknown as RepoMapService,
    github,
    // The real generator: the point of the commit-shape test is what the
    // committed workflow actually says, not what a stub was told to say.
    new RealWorkflowGenerator() as WorkflowGeneratorService,
    { get: jest.fn().mockReturnValue('https://flui.example') } as any,
    {
      prepareApplicationFromYaml: prepare,
    } as unknown as ApplicationSourceDeployService,
    workflow,
    applications,
    attached,
  );

  return { service, github, workflow, prepare, applications, attached };
}

describe('RepoApplyService — the refusals, before anything is written', () => {
  it('refuses a sandbox guest without reading or writing anything', async () => {
    const { service, github } = serviceUnder();
    await expect(
      service.apply('u', 'u@x.test', { ...REQUEST, isSandboxGuest: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(github.createBranchFrom).not.toHaveBeenCalled();
  });

  it('refuses when the repository could not be read', async () => {
    const { service, github } = serviceUnder({
      map: mapOf({ ok: false, reason: 'not-found' }),
    });
    await expect(
      service.apply('u', 'u@x.test', REQUEST),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(github.createBranchFrom).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'insufficient_capacity', 'not_assessed'])(
    'refuses a `%s` verdict and cuts no branch',
    async (outcome) => {
      const { service, github } = serviceUnder({ map: mapOf({ outcome }) });
      await expect(
        service.apply('u', 'u@x.test', REQUEST),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(github.createBranchFrom).not.toHaveBeenCalled();
    },
  );

  it('refuses when the render produced no unit, naming why each was skipped', async () => {
    const { service, github } = serviceUnder({
      map: mapOf({
        units: [],
        skipped: [{ unitId: 'worker', reason: 'no port could be read' }],
      }),
    });
    await expect(service.apply('u', 'u@x.test', REQUEST)).rejects.toThrow(
      /no port could be read/,
    );
    expect(github.createBranchFrom).not.toHaveBeenCalled();
  });

  it('refuses a unitId that has no rendered manifest', async () => {
    const { service, github } = serviceUnder();
    await expect(
      service.apply('u', 'u@x.test', { ...REQUEST, unitIds: ['ghost'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(github.createBranchFrom).not.toHaveBeenCalled();
  });

  it('lets the already-existing branch conflict through, having created nothing', async () => {
    const { service, prepare } = serviceUnder({
      createBranchFrom: jest
        .fn()
        .mockRejectedValue(new ConflictException('branch exists')),
    });
    await expect(
      service.apply('u', 'u@x.test', REQUEST),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('deletes the branch it cut when a later step fails', async () => {
    const { service, github } = serviceUnder({
      saveWebhookSecret: jest
        .fn()
        .mockRejectedValue(new BadRequestException('no secret access')),
    });
    await expect(service.apply('u', 'u@x.test', REQUEST)).rejects.toThrow(
      /no secret access/,
    );
    expect(github.deleteBranch).toHaveBeenCalledWith('u', 'acme', 'shop', HEAD);
    expect(github.commitFilesOnBranch).not.toHaveBeenCalled();
  });

  it('keeps the branch when the failure comes after the commit landed', async () => {
    // Past the commit, N builds are already running on the author's Actions
    // minutes. Deleting the branch would destroy work that really happened.
    const { service, github } = serviceUnder({
      markAwaitingExternalBuild: jest
        .fn()
        .mockRejectedValue(new Error('database went away')),
    });
    const result = await service.apply('u', 'u@x.test', REQUEST);

    expect(result.commitSha).toBe(COMMIT_SHA);
    expect(github.commitFilesOnBranch).toHaveBeenCalledTimes(1);
    expect(github.deleteBranch).not.toHaveBeenCalled();
  });
});

describe('RepoApplyService — the commit is cut from the commit the map read', () => {
  it('cuts at `read.commitSha` and never re-resolves the branch tip', async () => {
    // Re-resolving would resolve a *second* time: the map already read a
    // commit, rendered every manifest from it and named the branch after it.
    // A push landing between the two reads put manifests rendered from A on
    // top of B, under a branch called deploy-<A7>, with a response claiming
    // baseCommitSha A. Two false statements for one saved round trip.
    const { service, github } = serviceUnder();

    const result = await service.apply('u', 'u@x.test', REQUEST);

    expect(github.createBranchFrom).toHaveBeenCalledWith(
      'u',
      'acme',
      'shop',
      HEAD,
      BASE_SHA,
    );
    expect(result.baseCommitSha).toBe(BASE_SHA);
    expect(result.branch).toBe(`flui/deploy-${BASE_SHA.slice(0, 7)}`);
  });

  it('refuses, writing nothing, when the map recorded no commit at all', async () => {
    const map = mapOf();
    delete (map.read as { commitSha?: string }).commitSha;
    const { service, github } = serviceUnder({ map });

    await expect(service.apply('u', 'u@x.test', REQUEST)).rejects.toThrow(
      /did not record the commit it read/,
    );
    expect(github.createBranchFrom).not.toHaveBeenCalled();
  });
});

describe('RepoApplyService — applications a failed apply leaves behind', () => {
  const twoUnits = mapOf({
    units: [
      {
        unitId: 'api',
        name: 'shop-api',
        yaml: 'kind: Application\nmetadata:\n  name: shop-api\n',
      },
      {
        unitId: 'web',
        name: 'shop-web',
        yaml: 'kind: Application\nmetadata:\n  name: shop-web\n',
      },
    ],
  });

  /** Unit 1 prepares (and installs a Postgres); unit 2 fails. */
  function halfPrepared(o: { updateApplication?: jest.Mock } = {}) {
    const prepare = jest
      .fn()
      .mockResolvedValueOnce(
        preparedApp('app-api', 'shop-api-aa11', 'shop-api', 'api', {
          attachedServices: ['db=postgresql'],
        }),
      )
      .mockRejectedValueOnce(new Error('cluster has no room left'));
    return serviceUnder({ map: twoUnits, prepare, ...o });
  }

  it('names every application it left behind, with its services, instead of deleting it', async () => {
    // Preparing an application provisions the services its manifest declares,
    // so a rollback that deleted rows would take a database with it. In this
    // house that only happens through the removal preview, which offers a
    // snapshot first — so the apply names what exists and stops.
    const { service, github } = halfPrepared();

    const error = await service
      .apply('u', 'u@x.test', REQUEST)
      .catch((e) => e as HttpException);

    expect(error).toBeInstanceOf(HttpException);
    const body = (error as HttpException).getResponse() as any;
    expect(body.error).toBe('ApplyLeftApplicationsBehind');
    expect(body.strandedApplications).toEqual([
      {
        applicationId: 'app-api',
        name: 'shop-api',
        slug: 'shop-api-aa11',
        unitId: 'api',
        branch: HEAD,
        attachedServices: ['db=postgresql'],
      },
    ]);
    // The words a person needs to act: the id, the slug, the service, and the
    // failure that caused it.
    expect(body.message).toContain('app-api');
    expect(body.message).toContain('shop-api-aa11');
    expect(body.message).toContain('db=postgresql');
    expect(body.message).toContain('cluster has no room left');

    // The empty ref is the only thing the rollback is allowed to remove.
    expect(github.deleteBranch).toHaveBeenCalledWith('u', 'acme', 'shop', HEAD);
    expect(github.commitFilesOnBranch).not.toHaveBeenCalled();
  });

  it('marks them on the row, so the next apply can find them across branches', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const { service } = halfPrepared({ updateApplication: update });

    await service.apply('u', 'u@x.test', REQUEST).catch(() => undefined);

    expect(update).toHaveBeenCalledTimes(1);
    const [appId, patch] = update.mock.calls[0];
    expect(appId).toBe('app-api');
    const mark = JSON.parse(patch.metadata[STRANDED_APPLY_KEY]);
    expect(mark).toMatchObject({
      branch: HEAD,
      unitId: 'api',
      services: ['db=postgresql'],
    });
    expect(mark.reason).toContain('cluster has no room left');
  });

  it('says the next apply will NOT find them when the mark could not be written', async () => {
    // "They are marked, so the next apply reuses them" is a claim, and it is
    // false when the write that would make it true failed.
    const { service } = halfPrepared({
      updateApplication: jest.fn().mockRejectedValue(new Error('db is down')),
    });

    const error = await service
      .apply('u', 'u@x.test', REQUEST)
      .catch((e) => e as HttpException);

    const body = (error as HttpException).getResponse() as any;
    expect(body.markedForReuse).toBe(false);
    expect(body.message).toContain('could NOT mark them for reuse');
  });

  it('reuses a marked application instead of creating a second one beside it', async () => {
    // The branch is part of a manifest deploy's identity, so an application
    // stranded on deploy-<A7> is invisible to an apply from commit B: without
    // this it would be orphaned forever, database included.
    const stranded = {
      id: 'app-from-the-failed-try',
      slug: 'shop-ab12cd',
      name: 'shop',
      status: 'PENDING',
      webhookToken: null,
      sourceConfig: { type: 'git_build', repositoryId: REQUEST.repositoryId },
      metadata: {
        [STRANDED_APPLY_KEY]: JSON.stringify({
          at: '2026-09-01T00:00:00.000Z',
          branch: 'flui/deploy-0000000',
          unitId: '.',
          reason: 'the apply failed before it committed: boom',
          services: ['db=postgresql'],
        }),
      },
    };
    const { service, prepare } = serviceUnder({
      findByClusterId: jest.fn().mockResolvedValue([stranded]),
    });

    await service.apply('u', 'u@x.test', REQUEST);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][3]).toEqual({
      adoptApplicationId: 'app-from-the-failed-try',
    });
  });

  it.each([
    [
      'holds a webhook token — something is already reporting into it',
      { webhookToken: 'live-token' },
    ],
    [
      'carries no mark — it may be a concurrent apply mid-flight',
      { metadata: {} },
    ],
    [
      'belongs to another repository',
      { sourceConfig: { type: 'git_build', repositoryId: 'other-repo' } },
    ],
  ])('never reuses an application that %s', async (_why, patch) => {
    const candidate = {
      id: 'not-mine',
      slug: 'shop-ab12cd',
      name: 'shop',
      status: 'PENDING',
      webhookToken: null,
      sourceConfig: { type: 'git_build', repositoryId: REQUEST.repositoryId },
      metadata: { [STRANDED_APPLY_KEY]: '{}' },
      ...patch,
    };
    const { service, prepare } = serviceUnder({
      findByClusterId: jest.fn().mockResolvedValue([candidate]),
    });

    await service.apply('u', 'u@x.test', REQUEST);

    expect(prepare.mock.calls[0][3]).toBeUndefined();
  });

  it('only ever looks at applications that never deployed', async () => {
    const findByClusterId = jest.fn().mockResolvedValue([]);
    const { service } = serviceUnder({ findByClusterId });

    await service.apply('u', 'u@x.test', REQUEST);

    expect(findByClusterId).toHaveBeenCalledWith('cluster-uuid', {
      status: ApplicationStatus.PENDING,
    });
  });

  it('clears the mark from an application it managed to arm this time', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const { service } = serviceUnder({
      prepare: jest.fn().mockResolvedValue(
        preparedApp('app-1', 'shop-ab12cd', 'shop', undefined, {
          metadata: {
            [STRANDED_APPLY_KEY]: '{"branch":"flui/deploy-0000000"}',
          },
        }),
      ),
      updateApplication: update,
    });

    await service.apply('u', 'u@x.test', REQUEST);

    expect(update).toHaveBeenCalledWith('app-1', { metadata: {} });
  });
});

describe('RepoApplyService — when the commit landed but a unit could not be armed', () => {
  const twoUnits = mapOf({
    units: [
      {
        unitId: 'api',
        name: 'shop-api',
        yaml: 'kind: Application\nmetadata:\n  name: shop-api\n',
      },
      {
        unitId: 'web',
        name: 'shop-web',
        yaml: 'kind: Application\nmetadata:\n  name: shop-web\n',
      },
    ],
  });

  function oneArmingFails() {
    const byName: Record<string, unknown> = {
      'shop-api': preparedApp('app-api', 'shop-api-aa11', 'shop-api', 'api'),
      'shop-web': preparedApp('app-web', 'shop-web-bb22', 'shop-web', 'web'),
    };
    const prepare = jest.fn().mockImplementation((_u, dto) => {
      const name = /name: (\S+)/.exec(dto.yaml)?.[1] as string;
      return Promise.resolve(byName[name]);
    });
    return serviceUnder({
      map: twoUnits,
      prepare,
      markAwaitingExternalBuild: jest
        .fn()
        .mockResolvedValueOnce({ runId: '42' })
        .mockRejectedValueOnce(new Error('the write timed out')),
    });
  }

  it('answers with the branch, the commit, and which unit is armed — not a 500', async () => {
    // The builds of BOTH units are already running: the commit that starts
    // them landed. Throwing here would hide the branch, the commit and the
    // armed unit behind an error, and say nothing about the one that will
    // answer its own webhook with a 401.
    const { service } = oneArmingFails();

    const result = await service.apply('u', 'u@x.test', REQUEST);

    expect(result.branch).toBe(HEAD);
    expect(result.commitSha).toBe(COMMIT_SHA);
    expect(result.partial).toBe(true);
    expect(result.units.map((u) => [u.slug, u.status, u.armed])).toEqual([
      ['shop-api-aa11', 'AWAITING_BUILD', true],
      ['shop-web-bb22', 'PENDING', false],
    ]);
    expect(result.units[0].reason).toBeUndefined();
    expect(result.units[1].reason).toContain('the write timed out');
    expect(result.units[1].reason).toContain('401');
  });

  it('marks the unarmed one too, so it is not orphaned by the next apply either', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const { service } = serviceUnder({
      markAwaitingExternalBuild: jest
        .fn()
        .mockRejectedValue(new Error('the write timed out')),
      updateApplication: update,
    });

    await service.apply('u', 'u@x.test', REQUEST);

    const patch = update.mock.calls[0][1];
    expect(JSON.parse(patch.metadata[STRANDED_APPLY_KEY]).reason).toContain(
      'not armed after the commit',
    );
  });

  it('says nothing is partial when every unit was armed', async () => {
    const { service } = serviceUnder();
    const result = await service.apply('u', 'u@x.test', REQUEST);
    expect(result.partial).toBe(false);
    expect(result.units.every((u) => u.armed)).toBe(true);
  });
});

describe('RepoApplyService — the wait that is not spent per unit', () => {
  it('never asks a mark to wait on GitHub for the run id', async () => {
    // Resolving the run id needs a four-second wait before GitHub has it.
    // Serial, per unit, inside the request: a five-unit monorepo spent twenty
    // seconds sleeping. The build watcher resolves the run on its next tick.
    const map = mapOf({
      units: ['a', 'b', 'c'].map((id) => ({
        unitId: id,
        name: id,
        yaml: `kind: Application\nmetadata:\n  name: ${id}\n`,
      })),
    });
    const prepare = jest
      .fn()
      .mockImplementation((_u, dto) =>
        Promise.resolve(
          preparedApp(
            `app-${/name: (\S+)/.exec(dto.yaml)?.[1]}`,
            `slug-${/name: (\S+)/.exec(dto.yaml)?.[1]}`,
            /name: (\S+)/.exec(dto.yaml)?.[1] as string,
          ),
        ),
      );
    const { service, workflow } = serviceUnder({ map, prepare });

    await service.apply('u', 'u@x.test', REQUEST);

    const marks = (workflow.markAwaitingExternalBuild as jest.Mock).mock.calls;
    expect(marks).toHaveLength(3);
    for (const call of marks) {
      expect(call[2].resolveRun).toBe(false);
    }
  });
});

describe('RepoApplyService — what a partial map is allowed to deploy', () => {
  it('leaves a blocked unit out of the commit even though the render produced its yaml', async () => {
    // The renderer skips a unit for its own reasons (no port, a template build) but renders one
    // the verdict calls `blocked` — a docker socket, `privileged`, a build that wants secrets.
    // Selecting on the render alone committed that unit and spent the author's Actions minutes
    // reaching a conclusion the map had already reached for free.
    const map = mapOf({
      outcome: 'partial',
      units: [
        {
          unitId: 'api',
          name: 'api',
          yaml: 'kind: Application\nmetadata:\n  name: api\n',
        },
        {
          unitId: 'gpu',
          name: 'gpu',
          yaml: 'kind: Application\nmetadata:\n  name: gpu\n',
        },
      ],
      readiness: { api: 'deployable', gpu: 'blocked' },
    });
    const { service, github } = serviceUnder({ map });

    await service.apply('u', 'u@x.test', REQUEST);

    const files = (github.commitFilesOnBranch as jest.Mock).mock
      .calls[0][4] as Array<{ path: string }>;
    expect(files.some((f) => f.path.includes('gpu'))).toBe(false);
    expect(files.some((f) => f.path.includes('api'))).toBe(true);
  });

  it('refuses by name when the caller asks for a unit the map will not deploy', async () => {
    const map = mapOf({
      outcome: 'partial',
      units: [
        { unitId: 'api', name: 'api', yaml: 'kind: Application\n' },
        { unitId: 'gpu', name: 'gpu', yaml: 'kind: Application\n' },
      ],
      readiness: { api: 'deployable', gpu: 'blocked' },
    });
    const { service, github } = serviceUnder({ map });

    await expect(
      service.apply('u', 'u@x.test', { ...REQUEST, unitIds: ['gpu'] }),
    ).rejects.toThrow(/will not deploy/);
    expect(github.createBranchFrom).not.toHaveBeenCalled();
  });
});

describe('RepoApplyService — the repository webhook token', () => {
  it('reuses the token the repository already has instead of rotating it', async () => {
    // FLUI_WEBHOOK_TOKEN is a repository secret and every application of that repository is
    // checked against it. Minting a fresh one here rotated it out from under the application
    // already deploying from `main`: its next push answered 401 and its auto-deploy stopped
    // without a word, because the build watcher only reconciles AWAITING_BUILD.
    const { service, workflow } = serviceUnder({
      findWebhookTokenForRepository: jest
        .fn()
        .mockResolvedValue('token-in-use'),
    });

    await service.apply('u', 'u@x.test', REQUEST);

    expect(workflow.saveWebhookSecret).not.toHaveBeenCalled();
  });

  it('mints one only when nothing holds one yet', async () => {
    const { service, workflow } = serviceUnder({
      findWebhookTokenForRepository: jest.fn().mockResolvedValue(null),
    });

    await service.apply('u', 'u@x.test', REQUEST);

    expect(workflow.saveWebhookSecret).toHaveBeenCalled();
  });
});

describe('RepoApplyService — the residue nobody could name', () => {
  it('names the unit whose own preparation threw, with the database it already owns', async () => {
    // `prepareApplicationFromYaml` writes the Application row BEFORE it provisions the services,
    // and provisioning is the step most likely to fail. The row that failed was the only one the
    // rollback could not see: not in the error, not marked, and invisible to the next apply, which
    // read a different branch and built a second application with a second database beside it.
    const orphan = {
      id: 'app-orphan',
      slug: 'shop-zz99',
      name: 'shop',
      status: 'PENDING',
    };
    const { service, applications, attached } = serviceUnder({
      prepare: jest
        .fn()
        .mockRejectedValue(new Error('postgresql never reached RUNNING')),
      findByClusterId: jest.fn().mockResolvedValue([
        {
          ...orphan,
          sourceConfig: { repositoryId: REQUEST.repositoryId, branch: HEAD },
        },
      ]),
      attachmentsOf: jest
        .fn()
        .mockResolvedValue([{ name: 'db', block: 'postgresql' }]),
    });

    await expect(service.apply('u', 'u@x.test', REQUEST)).rejects.toMatchObject(
      {
        response: expect.objectContaining({
          error: 'ApplyLeftApplicationsBehind',
        }),
      },
    );

    expect(attached.attachmentsOf).toHaveBeenCalledWith('app-orphan');
    // Named in the error, and marked so the next apply adopts it rather than doubling it.
    const marked = (applications.update as jest.Mock).mock.calls.map(
      (c) => c[0],
    );
    expect(marked).toContain('app-orphan');
  });

  it('reports what the database holds when arming throws, not which call threw', async () => {
    // Arming is not one write: the status and the token land before the build row. A throw after
    // the first write left a row that was armed and would deploy, reported as `PENDING / armed:
    // false / answers 401` — false in the other direction, and marked for a reuse the filters
    // would never grant.
    const { service, applications } = serviceUnder({
      markAwaitingExternalBuild: jest
        .fn()
        .mockRejectedValue(new Error('build row write failed')),
      findById: jest.fn().mockResolvedValue({
        id: 'app-1',
        status: 'awaiting_build',
        webhookToken: 'a-token',
      }),
    });

    const result = await service.apply('u', 'u@x.test', REQUEST);

    expect(result.units[0]).toMatchObject({
      armed: true,
      status: 'AWAITING_BUILD',
    });
    expect(result.partial).toBe(false);
    // And it is not marked stranded: a healthy row must not be offered up for adoption.
    expect((applications.update as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('says the branch is still there when deleting it did not work', async () => {
    const { service } = serviceUnder({
      prepare: jest.fn().mockRejectedValue(new Error('nope')),
      deleteBranch: jest.fn().mockResolvedValue(false),
      findByClusterId: jest.fn().mockResolvedValue([
        {
          id: 'app-orphan',
          slug: 's',
          name: 'shop',
          sourceConfig: { repositoryId: REQUEST.repositoryId, branch: HEAD },
        },
      ]),
    });

    await expect(service.apply('u', 'u@x.test', REQUEST)).rejects.toMatchObject(
      {
        response: expect.objectContaining({ branchDeleted: false }),
      },
    );
  });
});

describe('RepoApplyService — the shape of the commit', () => {
  const monorepo = mapOf({
    units: [
      {
        unitId: 'api',
        name: 'shop-api',
        yaml: 'kind: Application\nmetadata:\n  name: shop-api\n',
      },
      {
        unitId: 'web',
        name: 'shop-web',
        yaml: 'kind: Application\nmetadata:\n  name: shop-web\n',
      },
    ],
  });

  function monorepoService() {
    const byName: Record<string, unknown> = {
      'shop-api': preparedApp('app-api', 'shop-api-aa11', 'shop-api', 'api'),
      'shop-web': preparedApp('app-web', 'shop-web-bb22', 'shop-web', 'web'),
    };
    const prepare = jest.fn().mockImplementation((_u, dto) => {
      const name = /name: (\S+)/.exec(dto.yaml)?.[1] as string;
      return Promise.resolve(byName[name]);
    });
    return serviceUnder({ map: monorepo, prepare });
  }

  it('commits one manifest and one workflow per unit, in a single commit', async () => {
    const { service, github } = monorepoService();
    const result = await service.apply('u', 'u@x.test', REQUEST);

    expect(github.commitFilesOnBranch).toHaveBeenCalledTimes(1);
    const [, , , branch, files] = (github.commitFilesOnBranch as jest.Mock).mock
      .calls[0];
    expect(branch).toBe(HEAD);
    expect(files.map((f: { path: string }) => f.path)).toEqual([
      'api/flui.yaml',
      '.github/workflows/flui-shop-api-aa11.yml',
      'web/flui.yaml',
      '.github/workflows/flui-shop-web-bb22.yml',
    ]);
    expect(result.branch).toBe(HEAD);
    expect(result.baseBranch).toBe('main');
    expect(result.baseCommitSha).toBe(BASE_SHA);
    expect(result.commitSha).toBe(COMMIT_SHA);
    expect(result.units.map((u) => u.applicationId)).toEqual([
      'app-api',
      'app-web',
    ]);
  });

  it('commits the rendered yaml verbatim — nothing about it comes from the caller', async () => {
    const { service, github } = monorepoService();
    await service.apply('u', 'u@x.test', REQUEST);
    const files = (github.commitFilesOnBranch as jest.Mock).mock.calls[0][4];
    expect(files[0].content).toBe(
      'kind: Application\nmetadata:\n  name: shop-api\n',
    );
  });

  it('points every committed workflow at the Flui branch, never at the base', async () => {
    const { service, github } = monorepoService();
    await service.apply('u', 'u@x.test', REQUEST);
    const files = (github.commitFilesOnBranch as jest.Mock).mock.calls[0][4];

    for (const workflow of files.filter((f: { path: string }) =>
      f.path.startsWith('.github/workflows/'),
    )) {
      expect(workflow.content).toContain(`branches: [${HEAD}]`);
      expect(workflow.content).not.toContain('branches: [main]');
    }
    // And each carries its own application's id, so the build reports back
    // against the right one.
    expect(files[1].content).toContain('FLUI_APP_ID: app-api');
    expect(files[3].content).toContain('FLUI_APP_ID: app-web');
  });

  it('creates the applications on the Flui branch, before it commits', async () => {
    const { service, github, prepare } = monorepoService();
    await service.apply('u', 'u@x.test', REQUEST);

    expect(prepare).toHaveBeenCalledTimes(2);
    for (const call of prepare.mock.calls) {
      expect(call[1].branch).toBe(HEAD);
      expect(call[1].clusterId).toBe('cluster-uuid');
      expect(call[1].repoFullName).toBe('acme/shop');
    }
    const commitOrder = (github.commitFilesOnBranch as jest.Mock).mock
      .invocationCallOrder[0];
    for (const order of prepare.mock.invocationCallOrder) {
      expect(order).toBeLessThan(commitOrder);
    }
  });

  it('writes one shared webhook token, and marks the apps only after the commit', async () => {
    const { service, github, workflow } = monorepoService();
    await service.apply('u', 'u@x.test', REQUEST);

    // One repository secret for the whole apply: N applications each writing
    // their own would overwrite each other on the repository.
    expect(workflow.saveWebhookSecret).toHaveBeenCalledTimes(1);
    const token = (workflow.saveWebhookSecret as jest.Mock).mock.calls[0][3];
    const marks = (workflow.markAwaitingExternalBuild as jest.Mock).mock.calls;
    expect(marks).toHaveLength(2);
    expect(marks.map((c) => c[2].webhookToken)).toEqual([token, token]);
    // Each app is marked against its own workflow file, so a monorepo's
    // applications cannot be handed the same run id.
    expect(marks.map((c) => c[2].workflowFileName)).toEqual([
      'flui-shop-api-aa11.yml',
      'flui-shop-web-bb22.yml',
    ]);

    const commitOrder = (github.commitFilesOnBranch as jest.Mock).mock
      .invocationCallOrder[0];
    for (const order of (workflow.markAwaitingExternalBuild as jest.Mock).mock
      .invocationCallOrder) {
      expect(order).toBeGreaterThan(commitOrder);
    }
  });

  it('applies only the units the caller named', async () => {
    const { service, github } = monorepoService();
    await service.apply('u', 'u@x.test', { ...REQUEST, unitIds: ['web'] });
    const files = (github.commitFilesOnBranch as jest.Mock).mock.calls[0][4];
    expect(files.map((f: { path: string }) => f.path)).toEqual([
      'web/flui.yaml',
      '.github/workflows/flui-shop-web-bb22.yml',
    ]);
  });
});

describe('manifestPathFor', () => {
  it('writes the root unit to the repository root', () => {
    expect(manifestPathFor('.')).toBe('flui.yaml');
    expect(manifestPathFor('')).toBe('flui.yaml');
  });

  it('writes a sub-unit into its own directory', () => {
    expect(manifestPathFor('api')).toBe('api/flui.yaml');
    expect(manifestPathFor('./services/api/')).toBe('services/api/flui.yaml');
  });
});

/**
 * What the caller still owes, said in the same answer as the apply.
 *
 * Without it an agent has to read each application back one at a time — N
 * round trips, each of which can be refused by a guard, after a write that
 * already succeeded. The names come off the row the apply just prepared, where
 * `materializeDeclaredSecrets` has already turned the render's `secret: true`
 * into pending keys.
 */
describe('RepoApplyService — the variables still owed', () => {
  it('names the pending keys of each unit, and never their values', async () => {
    const { service } = serviceUnder({
      prepare: jest.fn().mockResolvedValue(
        preparedApp('app-1', 'shop-ab12cd', 'shop', undefined, {
          env: [
            { name: 'PORT', value: '3000' } as any,
            { name: 'STRIPE_SECRET_KEY', secret: true, pending: true },
            { name: 'SESSION_SECRET', secret: true, pending: true },
          ],
        }),
      ),
    });
    const result = await service.apply('u', 'u@x.test', REQUEST);
    expect(result.units[0].pendingInputs).toEqual([
      'STRIPE_SECRET_KEY',
      'SESSION_SECRET',
    ]);
    // The names travel; nothing that could carry a value does.
    expect(JSON.stringify(result.units[0])).not.toContain('3000');
  });

  it('answers with an empty list, not a missing field, when nothing is owed', async () => {
    const { service } = serviceUnder({
      prepare: jest.fn().mockResolvedValue(
        preparedApp('app-1', 'shop-ab12cd', 'shop', undefined, {
          env: [{ name: 'PORT', value: '3000' } as any],
        }),
      ),
    });
    const result = await service.apply('u', 'u@x.test', REQUEST);
    expect(result.units[0].pendingInputs).toEqual([]);
  });

  it('survives a row that carries no env at all', async () => {
    const { service } = serviceUnder();
    const result = await service.apply('u', 'u@x.test', REQUEST);
    expect(result.units[0].pendingInputs).toEqual([]);
  });
});
