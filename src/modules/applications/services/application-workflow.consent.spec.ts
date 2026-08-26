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
import { FLUI_WEBHOOK_SECRET } from '../../repositories/services/workflow-generator.service';
import { ApplicationStatus } from '../enums/application-status.enum';

const REPO_ID = '11111111-1111-4111-8111-111111111111';

interface Harness {
  service: ApplicationWorkflowService;
  updates: Record<string, unknown>[];
  commits: { delivery?: string; workflowYaml: string }[];
  secrets: { name: string; value: string }[];
  /** What happened, in order — the ordering is the whole point of one test. */
  events: string[];
  runsLookedUp: number;
  buildsRecorded: number;
}

const build = (opts?: {
  pullRequest?: boolean;
  backendPollingOnly?: boolean;
  /** Name of a repository secret GitHub refuses to accept. */
  refuseSecret?: string;
}): Harness => {
  const updates: Record<string, unknown>[] = [];
  const commits: { delivery?: string; workflowYaml: string }[] = [];
  const secrets: { name: string; value: string }[] = [];
  const events: string[] = [];
  const harness = { runsLookedUp: 0, buildsRecorded: 0 };

  const applicationsRepository = {
    findById: async () => ({
      id: 'app-1',
      slug: 'their-app',
      sourceConfig: { type: 'git_build', repositoryId: REPO_ID },
    }),
    update: async (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch);
    },
  };

  const repositoriesRepository = {
    findById: async () => ({ owner: 'someone', repositoryName: 'their-app' }),
  };

  const githubWorkflowService = {
    commitWorkflowOnly: async (
      _u: string,
      _o: string,
      _r: string,
      _b: string,
      workflowYaml: string,
      o: { delivery?: string; workflowFileName?: string },
    ) => {
      events.push('commit');
      commits.push({ delivery: o.delivery, workflowYaml });
      return o.delivery === 'pull-request'
        ? {
            workflowUrl: 'https://github.com/someone/their-app/blob/flui/x',
            sha: 'abcdef1234567890',
            pullRequestUrl: 'https://github.com/someone/their-app/pull/1',
          }
        : {
            workflowUrl: 'https://github.com/someone/their-app/blob/main/x',
            sha: 'abcdef1234567890',
          };
    },
    getLatestWorkflowRun: async () => {
      harness.runsLookedUp += 1;
      return null;
    },
    saveRepoSecret: async (
      _u: string,
      _o: string,
      _r: string,
      name: string,
      value: string,
    ) => {
      events.push(`secret:${name}`);
      if (opts?.refuseSecret === name) {
        throw new Error('Resource not accessible by integration');
      }
      secrets.push({ name, value });
    },
  };

  const appBuildRepository = {
    find: async () => [],
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
    save: async () => {
      harness.buildsRecorded += 1;
      return { id: 'build-1' };
    },
    update: async () => undefined,
  };

  const configService = {
    get: (key: string) =>
      key === 'WEBHOOK_BASE_URL'
        ? 'https://api.example.test'
        : key === 'BACKEND_POLLING_ONLY'
          ? opts?.backendPollingOnly
            ? 'true'
            : 'false'
          : undefined,
  };

  const service = new ApplicationWorkflowService(
    applicationsRepository as never,
    repositoriesRepository as never,
    githubWorkflowService as never,
    { isAppMode: async () => false } as never,
    new WorkflowGeneratorService(),
    configService as never,
    {} as never,
    appBuildRepository as never,
    { getDecryptedGhcrPat: async () => null } as never,
  );

  return {
    service,
    updates,
    commits,
    secrets,
    events,
    get runsLookedUp() {
      return harness.runsLookedUp;
    },
    get buildsRecorded() {
      return harness.buildsRecorded;
    },
  };
};

/**
 * A consent screen is only worth showing if what it shows is what happens. The
 * first block below is that equality, held as a test rather than as a habit:
 * the preview is the real generator's output, and the only thing that differs
 * between it and the committed file is a token that does not exist yet.
 */
describe('the workflow a person is asked to consent to', () => {
  it('previews the file the commit would write, character for character', async () => {
    const { service, commits } = build();

    const consent = await service.previewWorkflowV3('app-1', 'u1', {
      branch: 'main',
    });
    await service.generateAndCommitWorkflowV3('app-1', 'u1', {
      branch: 'main',
    });

    // Nothing differs any more: the one argument that used to — the webhook
    // token — is not in the file at all now, it is a repository secret.
    expect(consent.workflowYaml).toBe(commits[0].workflowYaml);
  }, 15_000);

  it('shows the body whole — the trigger, the registry login and the notify steps', async () => {
    const { service } = build();
    const consent = await service.previewWorkflowV3('app-1', 'u1', {
      branch: 'main',
    });

    expect(consent.workflowYaml).toContain('on:');
    expect(consent.workflowYaml).toContain('branches: [main]');
    expect(consent.workflowYaml).toContain('ghcr.io/someone/their-app');
    expect(consent.workflowYaml).toContain('Notify Flui');
    expect(consent.workflowYaml.trimEnd().split('\n').length).toBeGreaterThan(
      40,
    );
  });

  it('names the repository secret the shown file reads, and shows no credential', async () => {
    const { service } = build();
    const consent = await service.previewWorkflowV3('app-1', 'u1', {
      branch: 'main',
    });
    expect(consent.webhookSecretName).toBe(FLUI_WEBHOOK_SECRET);
    expect(consent.workflowYaml).toContain(
      `\${{ secrets.${FLUI_WEBHOOK_SECRET} }}`,
    );
    expect(consent.writes.map((w) => w.target)).toContain(
      `Repository secret ${FLUI_WEBHOOK_SECRET}`,
    );
  });

  it('names no secret when backend polling strips the webhook call out of the file', async () => {
    const { service } = build({ backendPollingOnly: true });
    const consent = await service.previewWorkflowV3('app-1', 'u1', {
      branch: 'main',
    });
    expect(consent.workflowYaml).not.toContain('X-Flui-Token');
    expect(consent.webhookSecretName).toBeNull();
    expect(consent.webhookSecretNote).toBeNull();
    expect(consent.writes.map((w) => w.target)).not.toContain(
      `Repository secret ${FLUI_WEBHOOK_SECRET}`,
    );
  });

  it('writes nothing at all', async () => {
    const { service, updates, commits } = build();
    await service.previewWorkflowV3('app-1', 'u1', { branch: 'main' });
    expect(updates).toEqual([]);
    expect(commits).toEqual([]);
  });

  it('tells a guest it will propose, not push, whatever the client asked for', async () => {
    const { service } = build();
    const consent = await service.previewWorkflowV3(
      'app-1',
      'u1',
      { branch: 'main', delivery: 'push' },
      true,
    );
    expect(consent.delivery).toBe('pull-request');
  });
});

describe('committing on behalf of a guest', () => {
  it('proposes instead of pushing', async () => {
    const { service, commits } = build();
    await service.generateAndCommitWorkflowV3(
      'app-1',
      'u1',
      { branch: 'main' },
      true,
    );
    expect(commits[0].delivery).toBe('pull-request');
  });

  it('returns the pull request and says no build started', async () => {
    const { service } = build();
    const result = await service.generateAndCommitWorkflowV3(
      'app-1',
      'u1',
      { branch: 'main' },
      true,
    );
    expect(result.pullRequestUrl).toBe(
      'https://github.com/someone/their-app/pull/1',
    );
    expect(result.buildStarted).toBe(false);
  });

  it('does not park the application on a build that cannot exist yet', async () => {
    const { service, updates } = build();
    await service.generateAndCommitWorkflowV3(
      'app-1',
      'u1',
      { branch: 'main' },
      true,
    );
    for (const patch of updates) {
      expect(patch.status).not.toBe(ApplicationStatus.AWAITING_BUILD);
      expect(patch.buildStartedAt).toBeUndefined();
    }
  });

  it('does not go looking for a run that no branch triggered', async () => {
    const harness = build();
    await harness.service.generateAndCommitWorkflowV3(
      'app-1',
      'u1',
      { branch: 'main' },
      true,
    );
    expect(harness.runsLookedUp).toBe(0);
    expect(harness.buildsRecorded).toBe(0);
  });
});

describe('committing for the owner of the repository', () => {
  it('still pushes, and still starts a build', async () => {
    const harness = build();
    const result = await harness.service.generateAndCommitWorkflowV3(
      'app-1',
      'u1',
      { branch: 'main' },
    );
    expect(harness.commits[0].delivery).toBe('push');
    expect(result.buildStarted).toBe(true);
    expect(result.pullRequestUrl).toBeUndefined();
    expect(
      harness.updates.some(
        (p) => p.status === ApplicationStatus.AWAITING_BUILD,
      ),
    ).toBe(true);
  }, 15_000);
});

/**
 * The defect this block exists for: the webhook token used to be written into
 * the committed YAML as literal text. That header is not a secret that merely
 * leaks — it is the deploy trigger. Anyone who could read the repository could
 * post `{appId, imageRef, status:"success"}` and have Flui roll out an image of
 * their choosing.
 *
 * So the assertions below are on the *committed body*, captured from the fake
 * commit, not on the arguments handed to the generator. A test on the
 * parameters would have stayed green through the whole defect.
 */
describe('the credential the committed file no longer carries', () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  it('commits a file with no token in it, and reads one from the repository secrets instead', async () => {
    const harness = build();
    await harness.service.generateAndCommitWorkflowV3('app-1', 'u1', {
      branch: 'main',
    });

    const committed = harness.commits[0].workflowYaml;
    const stored = harness.updates.find((p) => p.webhookToken)!
      .webhookToken as string;

    expect(committed).not.toContain(stored);
    expect(committed).not.toMatch(UUID);
    expect(committed).toContain(`X-Flui-Token: $${FLUI_WEBHOOK_SECRET}`);
    expect(committed).toContain(
      `${FLUI_WEBHOOK_SECRET}: \${{ secrets.${FLUI_WEBHOOK_SECRET} }}`,
    );
  }, 15_000);

  it('writes the secret before the commit that reads it', async () => {
    const harness = build();
    await harness.service.generateAndCommitWorkflowV3('app-1', 'u1', {
      branch: 'main',
    });

    expect(
      harness.events.indexOf(`secret:${FLUI_WEBHOOK_SECRET}`),
    ).toBeGreaterThan(-1);
    expect(
      harness.events.indexOf(`secret:${FLUI_WEBHOOK_SECRET}`),
    ).toBeLessThan(harness.events.indexOf('commit'));
  }, 15_000);

  it('puts in the secret exactly the value the webhook will be checked against', async () => {
    const harness = build();
    await harness.service.generateAndCommitWorkflowV3('app-1', 'u1', {
      branch: 'main',
    });

    const written = harness.secrets.find(
      (s) => s.name === FLUI_WEBHOOK_SECRET,
    )!;
    const stored = harness.updates.find((p) => p.webhookToken)!
      .webhookToken as string;
    expect(written.value).toBe(stored);
  }, 15_000);

  /**
   * The product decision, pinned: rather than commit a workflow that cannot
   * report back, Flui commits nothing. A half-written repository is worse than
   * an error message, because the error at least belongs to us.
   */
  it('commits nothing at all when the secret cannot be written', async () => {
    const harness = build({ refuseSecret: FLUI_WEBHOOK_SECRET });

    await expect(
      harness.service.generateAndCommitWorkflowV3('app-1', 'u1', {
        branch: 'main',
      }),
    ).rejects.toThrow(FLUI_WEBHOOK_SECRET);

    expect(harness.commits).toEqual([]);
    expect(harness.updates).toEqual([]);
  }, 15_000);

  /**
   * `secrets.FLUI_GHCR_TOKEN || secrets.GITHUB_TOKEN` is a sound fallback for
   * the registry login: the second credential works. There is no second webhook
   * credential, so the same shape here would post an empty header, take a 401,
   * and leave nothing in the run log to read a cause out of.
   */
  it('stops the step with a reason rather than calling the webhook uncredentialed', async () => {
    const harness = build();
    await harness.service.generateAndCommitWorkflowV3('app-1', 'u1', {
      branch: 'main',
    });

    const committed = harness.commits[0].workflowYaml;
    expect(committed).toContain(`if [ -z "$${FLUI_WEBHOOK_SECRET}" ]; then`);
    expect(committed).toContain('::error::');
    expect(committed).toContain('exit 1');
    expect(committed).not.toContain(`secrets.${FLUI_WEBHOOK_SECRET} ||`);
    expect(committed).not.toContain(`|| secrets.${FLUI_WEBHOOK_SECRET}`);
  }, 15_000);

  it('writes no webhook secret when the file makes no webhook call', async () => {
    const harness = build({ backendPollingOnly: true });
    await harness.service.generateAndCommitWorkflowV3('app-1', 'u1', {
      branch: 'main',
    });

    expect(harness.commits[0].workflowYaml).not.toContain('X-Flui-Token');
    expect(harness.secrets.map((s) => s.name)).not.toContain(
      FLUI_WEBHOOK_SECRET,
    );
  }, 15_000);
});
