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
 * Defect 156, pinned where it happened.
 *
 * `deployFromYaml` called `applicationService.create(clusterId, dto, userId)`
 * with three arguments from the first public release. `create` read the missing
 * fourth as "no owner" and placed the row in `default` — a namespace no tenancy
 * owns. The row was written, the deploy succeeded, and nothing anywhere said a
 * word.
 *
 * What falls with the namespace, all at once:
 *   - the `ResourceQuota` and `LimitRange` applied to the tenancy namespace;
 *   - the `NetworkPolicy` that isolates the tenancy;
 *   - the `noindex` middleware attached to the tenancy namespace;
 *   - the sandbox branch of `EndpointHostGuardService`, which asks
 *     `sandboxTenants.exists({clusterId, namespace})` before it constrains a
 *     hostname — so the manifest's `deploy.domain.fqdn` escaped the tenancy
 *     subdomain entirely;
 *   - the expiry sweep in `SandboxTenantService`, which deletes rows and the
 *     namespace by `k8sNamespace` — so the application outlived the tenancy
 *     that asked for it.
 *
 * The suite asserts the argument reaches `create`, because that is the fact the
 * five protections hang off. It does not re-assert what `create` then does with
 * it: that is `application.service.namespace.spec.ts`.
 */
describe('ApplicationSourceDeployService.deployFromYaml — namespace ownership', () => {
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

  const createCalls: unknown[][] = [];

  const build = (existingApp: Record<string, unknown> | null = null) => {
    createCalls.length = 0;

    const applicationsRepository = {
      findByClusterId: async () => (existingApp ? [existingApp] : []),
      findById: async () => existingApp,
      update: async () => undefined,
    };
    const repositoriesRepository = {
      findByUserIdAndFullName: async () => ({
        id: 'repo-1',
        cloneUrl: 'https://github.com/acme/probe.git',
      }),
    };
    const githubAppService = { isEnabled: async () => false };
    const githubOAuthService = { getStatus: async () => ({ connected: true }) };
    const githubAppUserAuthService = {
      getGhcrPatStatus: async () => ({ configured: true, status: 'VALID' }),
    };
    const applicationService = {
      create: async (...args: unknown[]) => {
        createCalls.push(args);
        return { id: 'app-1', slug: 'probe', name: 'probe' };
      },
    };
    const applicationDeployService = {
      deploy: async () => ({ id: 'op-1' }),
    };

    // Constructor order: applicationsRepository, repositoriesRepository,
    // githubOAuthService, githubAppService, githubAppUserAuthService,
    // ghcrPackagesService, applicationWorkflowService, applicationService,
    // repositoriesService, applicationDeployService, … (the rest is unused on
    // this path).
    return new (ApplicationSourceDeployService as unknown as new (
      ...args: unknown[]
    ) => ApplicationSourceDeployService)(
      applicationsRepository,
      repositoriesRepository,
      githubOAuthService,
      githubAppService,
      githubAppUserAuthService,
      undefined,
      undefined,
      applicationService,
      undefined,
      applicationDeployService,
      ...new Array(3).fill(undefined),
    );
  };

  const dto = (): DeployFromYamlDto =>
    ({
      clusterId: 'cluster-1',
      repoFullName: 'acme/probe',
      yaml: YAML,
      // Short-circuits the build so the run ends at the deploy stub instead of
      // committing a workflow to GitHub.
      imageRef: 'ghcr.io/acme/probe:abc1234',
    }) as DeployFromYamlDto;

  it("passes the caller's email down to create, so the app lands in the caller's namespace", async () => {
    const service = build();
    await service.deployFromYaml('u1', dto(), 'guest-1f23@try.flui.cloud');

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0][2]).toBe('u1');
    expect(createCalls[0][3]).toBe('guest-1f23@try.flui.cloud');
  });

  /**
   * The regression guard proper. Dropping the argument again — or reinstating a
   * `?? undefined` in its place — leaves `create` reading "no owner", which is
   * exactly the shape that used to resolve to `default`. Asserting "not
   * undefined" catches the omission even if `create` were later changed to
   * tolerate it again.
   */
  it('never reaches create without an owner', async () => {
    const service = build();
    await service.deployFromYaml('u1', dto(), 'dawit@example.com');

    expect(createCalls[0]).toHaveLength(4);
    expect(createCalls[0][3]).toBeDefined();
    expect(createCalls[0][3]).not.toBe('');
  });

  /**
   * The update branch is the one that carries the rows already sitting in
   * `default`: an app found by (cluster, repository, branch, name) is patched
   * in place and its `k8sNamespace` is never recomputed. This is not a bug to
   * fix here — moving a workload between namespaces is a Kubernetes move, not
   * an UPDATE — but it must be a documented fact rather than a surprise, so it
   * is pinned: nothing on the update path touches placement.
   */
  it('leaves the namespace of an existing app alone — placement is decided once, at create', async () => {
    const service = build({
      id: 'app-old',
      slug: 'probe',
      name: 'probe',
      k8sNamespace: 'default',
      metadata: {},
      env: [],
      sourceConfig: {
        type: 'git_build',
        repositoryId: 'repo-1',
        branch: 'main',
      },
    });

    await service.deployFromYaml('u1', dto(), 'dawit@example.com');

    expect(createCalls).toHaveLength(0);
  });
});
