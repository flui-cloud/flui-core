// The service's import graph reaches ESM-only packages (Kubernetes client, jose
// via jwks-rsa) that ts-jest cannot transform; stub them — this suite touches
// none of them.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import { ApplicationSourceDeployService } from './application-source-deploy.service';

/**
 * `reapplyManifestAtCommit` is the git-push-triggered redeploy path, the one
 * an app actually rides every time its branch moves.
 */
describe('ApplicationSourceDeployService — generate/userInput on source deploys', () => {
  const YAML = `
apiVersion: flui.cloud/v1beta1
kind: Application
metadata:
  name: probe
build:
  strategy: dockerfile
deploy:
  port: 3000
  env:
    JWT_SECRET:
      valueFrom:
        generate: secret
        length: 32
    ADMIN_EMAIL:
      valueFrom:
        userInput:
          default: admin@example.com
    ADMIN_PASSWORD:
      valueFrom:
        userInput: {}
`;

  const build = (app: Record<string, unknown>) => {
    const updateCalls: Record<string, unknown>[] = [];
    let stored = { ...app };

    const applicationsRepository = {
      findById: async () => stored,
      update: async (_id: string, patch: Record<string, unknown>) => {
        updateCalls.push(patch);
        stored = { ...stored, ...patch };
      },
    };
    const repositoriesRepository = {
      findById: async () => ({ repositoryFullName: 'acme/probe' }),
    };
    const repositoriesService = {
      getFluiManifests: async () => ({
        manifests: [
          { valid: true, content: YAML, name: 'probe', path: 'flui.yaml' },
        ],
      }),
    };

    // Constructor order: applicationsRepository, repositoriesRepository,
    // githubOAuthService, githubAppService, githubAppUserAuthService,
    // ghcrPackagesService, applicationWorkflowService, applicationService,
    // repositoriesService, applicationDeployService, appEndpointService,
    // appEndpointReconciliationService, clusterDnsZoneService, clustersService
    // — only the first two and repositoriesService are read on this path.
    const service = new (ApplicationSourceDeployService as unknown as new (
      ...args: unknown[]
    ) => ApplicationSourceDeployService)(
      applicationsRepository,
      repositoriesRepository,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      repositoriesService,
      ...new Array(5).fill(undefined),
    );

    return { service, updateCalls };
  };

  const baseApp = {
    id: 'app-1',
    userId: 'u1',
    slug: 'probe',
    name: 'probe',
    clusterId: 'cluster-1',
    projectId: null,
    sourceType: 'git_build',
    exposure: 'public',
    metadata: {},
    env: [] as unknown[],
    sourceConfig: { type: 'git_build', repositoryId: 'repo-1', branch: 'main' },
  };

  it('generates a fresh secret on first deploy and keeps it stable on redeploy', async () => {
    const { service, updateCalls } = build(baseApp);

    await service.reapplyManifestAtCommit('app-1', 'abc1234', 'main');
    expect(updateCalls).toHaveLength(1);
    const firstEnv = updateCalls[0].env as Array<Record<string, unknown>>;
    const jwt = firstEnv.find((e) => e.name === 'JWT_SECRET');
    expect(jwt).toMatchObject({
      source: 'manifest',
      secret: true,
      generated: true,
    });
    expect(jwt?.value as string).toHaveLength(32);

    await service.reapplyManifestAtCommit('app-1', 'def5678', 'main');
    const secondEnv = updateCalls[1].env as Array<Record<string, unknown>>;
    const jwtAgain = secondEnv.find((e) => e.name === 'JWT_SECRET');
    expect(jwtAgain?.value).toBe(jwt?.value);
  });

  it('seeds valueFrom.userInput.default once, as a user-owned value the manifest never reclaims', async () => {
    const { service, updateCalls } = build(baseApp);

    await service.reapplyManifestAtCommit('app-1', 'abc1234', 'main');
    const firstEnv = updateCalls[0].env as Array<Record<string, unknown>>;
    expect(firstEnv.find((e) => e.name === 'ADMIN_EMAIL')).toMatchObject({
      value: 'admin@example.com',
      source: 'user',
    });
  });

  it('never resets a value a human already set, even though the manifest still declares a default', async () => {
    const existingEnv = [
      { name: 'ADMIN_EMAIL', value: 'real@company.com', source: 'user' },
    ];
    const { service, updateCalls } = build({ ...baseApp, env: existingEnv });

    await service.reapplyManifestAtCommit('app-1', 'abc1234', 'main');
    const env = updateCalls[0].env as Array<Record<string, unknown>>;
    expect(env.find((e) => e.name === 'ADMIN_EMAIL')).toMatchObject({
      value: 'real@company.com',
      source: 'user',
    });
  });

  it('deploys without ADMIN_PASSWORD (no default, nothing stored) rather than throwing', async () => {
    const { service, updateCalls } = build(baseApp);

    await expect(
      service.reapplyManifestAtCommit('app-1', 'abc1234', 'main'),
    ).resolves.toBeUndefined();
    const env = updateCalls[0].env as Array<Record<string, unknown>>;
    expect(env.find((e) => e.name === 'ADMIN_PASSWORD')).toBeUndefined();
  });
});
