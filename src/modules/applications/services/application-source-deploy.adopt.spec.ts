// The service's import graph reaches ESM-only packages (Kubernetes client, jose
// via jwks-rsa) that ts-jest cannot transform; stub them — this suite touches
// none of them.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import { ApplicationSourceDeployService } from './application-source-deploy.service';
import { DeployFromYamlDto } from '../dto/deploy-from-yaml.dto';

/**
 * Reusing an application an earlier attempt left behind.
 *
 * A manifest deploy is identified by (cluster, repository, branch, name), and
 * the apply cuts one branch per base commit — so an application prepared on
 * `flui/deploy-<A7>` and abandoned there is invisible to an apply from commit
 * B. Without a way to hand the row over, every retry creates another
 * application, and every one of them keeps the database its manifest asked
 * for. This is that way, and these are its two refusals.
 */
describe('prepareApplicationFromYaml — reusing an application left behind', () => {
  const YAML = `
apiVersion: flui.cloud/v1beta1
kind: Application
metadata:
  name: probe
build:
  strategy: dockerfile
deploy:
  port: 3000
`;

  const build = (rows: Record<string, Record<string, unknown>>) => {
    const createCalls: unknown[][] = [];
    const updateCalls: Array<[string, Record<string, unknown>]> = [];

    const applicationsRepository = {
      // Nothing matches by identity: the branch below is a fresh Flui branch.
      findByClusterId: async () => [],
      findById: async (id: string) => rows[id] ?? null,
      update: async (id: string, patch: Record<string, unknown>) => {
        updateCalls.push([id, patch]);
        Object.assign(rows[id] ?? {}, patch);
      },
    };
    const repositoriesRepository = {
      findByUserIdAndFullName: async () => ({
        id: 'repo-1',
        cloneUrl: 'https://github.com/acme/probe.git',
      }),
    };
    const applicationService = {
      create: async (...args: unknown[]) => {
        createCalls.push(args);
        const created = {
          id: 'app-new',
          slug: 'probe-new',
          name: 'probe',
          clusterId: 'cluster-1',
          metadata: {},
        };
        rows['app-new'] = created;
        return created;
      },
    };

    // Constructor order: applicationsRepository, repositoriesRepository,
    // githubOAuthService, githubAppService, githubAppUserAuthService,
    // ghcrPackagesService, applicationWorkflowService, applicationService, …
    const service = new (ApplicationSourceDeployService as unknown as new (
      ...args: unknown[]
    ) => ApplicationSourceDeployService)(
      applicationsRepository,
      repositoriesRepository,
      { getStatus: async () => ({ connected: true }) },
      { isEnabled: async () => false },
      { getGhcrPatStatus: async () => ({ configured: true, status: 'VALID' }) },
      undefined,
      undefined,
      applicationService,
      ...new Array(4).fill(undefined),
    );

    return { service, createCalls, updateCalls };
  };

  const dto = (): DeployFromYamlDto =>
    ({
      clusterId: 'cluster-1',
      repoFullName: 'acme/probe',
      yaml: YAML,
      branch: 'flui/deploy-bbbbbbb',
    }) as DeployFromYamlDto;

  const stranded = () => ({
    'app-left-behind': {
      id: 'app-left-behind',
      slug: 'probe-aa11',
      name: 'probe',
      clusterId: 'cluster-1',
      metadata: { 'flui.apply.stranded': '{"branch":"flui/deploy-aaaaaaa"}' },
      sourceConfig: {
        type: 'git_build',
        repositoryId: 'repo-1',
        branch: 'flui/deploy-aaaaaaa',
      },
      env: [],
    },
  });

  it('reuses the named row and rebinds it to the new branch, creating nothing', async () => {
    const { service, createCalls, updateCalls } = build(stranded());

    const result = await service.prepareApplicationFromYaml(
      'u1',
      dto(),
      'u1@x.test',
      { adoptApplicationId: 'app-left-behind' },
    );

    expect(createCalls).toHaveLength(0);
    expect(result.app.id).toBe('app-left-behind');
    expect(result.adopted).toBe(true);
    // The branch is part of the identity, so the row now belongs to this apply.
    const [, patch] = updateCalls[0];
    expect((patch.sourceConfig as { branch: string }).branch).toBe(
      'flui/deploy-bbbbbbb',
    );
  });

  it('creates a new application when the row it was told to reuse is gone', async () => {
    // A removed orphan is the outcome the removal preview exists to produce:
    // a person decided, saw what would go with it, and it went. Nothing here
    // should resurrect it or fail because of it.
    const { service, createCalls } = build({});

    const result = await service.prepareApplicationFromYaml(
      'u1',
      dto(),
      'u1@x.test',
      { adoptApplicationId: 'app-left-behind' },
    );

    expect(createCalls).toHaveLength(1);
    expect(result.app.id).toBe('app-new');
    expect(result.adopted).toBe(false);
  });

  it('refuses to reuse a row that belongs to another cluster', async () => {
    const rows = stranded();
    rows['app-left-behind'].clusterId = 'some-other-cluster';
    const { service, createCalls } = build(rows);

    const result = await service.prepareApplicationFromYaml(
      'u1',
      dto(),
      'u1@x.test',
      { adoptApplicationId: 'app-left-behind' },
    );

    expect(createCalls).toHaveLength(1);
    expect(result.app.id).toBe('app-new');
    expect(result.adopted).toBe(false);
  });

  it('names the services it brought up — none here, and the field is still there', async () => {
    // The apply reports these back when it has to leave an application behind;
    // an absent field would make "no attached services" and "we did not look"
    // the same sentence.
    const { service } = build(stranded());

    const result = await service.prepareApplicationFromYaml(
      'u1',
      dto(),
      'u1@x.test',
      { adoptApplicationId: 'app-left-behind' },
    );

    expect(result.attachedServices).toEqual([]);
  });
});
