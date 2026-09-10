// The service's import graph reaches @octokit/rest, which ships ESM only.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { ApplicationWorkflowService } from './application-workflow.service';
import { WorkflowGeneratorService } from '../../repositories/services/workflow-generator.service';
import { ApplicationStatus } from '../enums/application-status.enum';

/**
 * Marking is what an apply does N times in a row, inside one HTTP request, and
 * the four-second wait it used to take unconditionally was therefore a wait
 * multiplied by the number of applications in a monorepo. These tests hold the
 * two halves of the fix: the wait is skippable, and skipping it still records
 * everything the build watcher needs to find the run later.
 */
const build = () => {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const savedBuilds: Record<string, unknown>[] = [];
  const harness = { runsLookedUp: 0 };

  const applicationsRepository = {
    findById: async () => ({
      id: 'app-1',
      slug: 'their-app',
      sourceConfig: { type: 'git_build' },
    }),
    update: async (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
    },
  };

  const githubWorkflowService = {
    getLatestWorkflowRun: async () => {
      harness.runsLookedUp += 1;
      return {
        runId: '99',
        url: 'https://github.com/o/r/actions/runs/99',
        status: 'queued',
      };
    },
  };

  const appBuildRepository = {
    find: async () => [],
    findOne: async () => null,
    createQueryBuilder: () => {
      const qb: Record<string, unknown> = {};
      for (const m of ['select', 'where', 'andWhere', 'orderBy', 'limit']) {
        qb[m] = () => qb;
      }
      qb.getMany = async () => [];
      qb.getOne = async () => null;
      return qb;
    },
    create: (patch: Record<string, unknown>) => ({ id: 'build-1', ...patch }),
    save: async (entity: Record<string, unknown>) => {
      savedBuilds.push(entity);
      return { id: 'build-1', ...entity };
    },
    update: async () => undefined,
  };

  const service = new ApplicationWorkflowService(
    applicationsRepository as never,
    { findById: async () => ({ owner: 'o', repositoryName: 'r' }) } as never,
    githubWorkflowService as never,
    { isAppMode: async () => false } as never,
    new WorkflowGeneratorService(),
    { get: () => undefined } as never,
    {} as never,
    appBuildRepository as never,
    { getDecryptedGhcrPat: async () => null } as never,
  );

  return {
    service,
    updates,
    savedBuilds,
    get runsLookedUp() {
      return harness.runsLookedUp;
    },
  };
};

const params = (over: Record<string, unknown> = {}) => ({
  app: { sourceConfig: { type: 'git_build' } },
  owner: 'o',
  repo: 'r',
  branch: 'flui/deploy-3f9a2c1',
  workflowFileName: 'flui-their-app.yml',
  commitSha: 'c'.repeat(40),
  workflowUrl: 'https://github.com/o/r/blob/flui/deploy-3f9a2c1/wf.yml',
  webhookToken: 'tok',
  isFluiManaged: true,
  buildStarted: true,
  ...over,
});

describe('markAwaitingExternalBuild — the wait for the run id', () => {
  it('returns without waiting when the caller asks it not to resolve the run', async () => {
    const h = build();
    const started = Date.now();

    const result = await h.service.markAwaitingExternalBuild(
      'app-1',
      'u1',
      params({ resolveRun: false }),
    );

    // The wait was four seconds, per application, serial, inside the request.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(h.runsLookedUp).toBe(0);
    expect(result.runId).toBeUndefined();
  });

  it('still records everything the watcher needs to find that run later', async () => {
    // Skipping the lookup is only affordable because the watcher does it: it
    // matches on the AppBuild row's commit and the workflow file name, both of
    // which are written here regardless.
    const h = build();

    await h.service.markAwaitingExternalBuild(
      'app-1',
      'u1',
      params({ resolveRun: false }),
    );

    expect(h.updates[0].patch).toMatchObject({
      status: ApplicationStatus.AWAITING_BUILD,
      webhookToken: 'tok',
      buildPath: 'github-actions',
    });
    expect(h.savedBuilds).toHaveLength(1);
    expect(h.savedBuilds[0]).toMatchObject({
      applicationId: 'app-1',
      branch: 'flui/deploy-3f9a2c1',
      commitSha: 'c'.repeat(40),
    });
  });

  it('records the configuration and starts no clock when no build was started', async () => {
    const h = build();

    await h.service.markAwaitingExternalBuild(
      'app-1',
      'u1',
      params({ buildStarted: false }),
    );

    expect(h.updates[0].patch).not.toHaveProperty('status');
    expect(h.savedBuilds).toHaveLength(0);
    expect(h.runsLookedUp).toBe(0);
  });
});
