jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import { ApplicationSourceDeployService } from './application-source-deploy.service';
import { DeployFromYamlDto } from '../dto/deploy-from-yaml.dto';

const ARM_WARNING =
  'Arm server: apps deployed from a repository are built for x86 and will not run on it. Catalog apps run normally.';

describe('ApplicationSourceDeployService.deployFromYaml — arm servers', () => {
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

  const build = (liveNodeFacts: () => Promise<unknown>) => {
    const applicationsRepository = {
      findByClusterId: async () => [],
      findById: async () => null,
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
      create: async () => ({ id: 'app-1', slug: 'probe', name: 'probe' }),
    };
    const applicationDeployService = {
      deploy: async () => ({ id: 'op-1' }),
    };
    const clustersService = { liveNodeFacts: jest.fn(liveNodeFacts) };

    const service = new (ApplicationSourceDeployService as unknown as new (
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
      undefined,
      undefined,
      undefined,
      clustersService,
      undefined,
      undefined,
    );
    return { service, clustersService };
  };

  const dto = (): DeployFromYamlDto =>
    ({
      clusterId: 'cluster-1',
      repoFullName: 'acme/probe',
      yaml: YAML,
      imageRef: 'ghcr.io/acme/probe:abc1234',
    }) as DeployFromYamlDto;

  const nodes = (...architectures: Array<'x86' | 'arm' | null>) =>
    new Map(
      architectures.map((architecture, i) => [
        `node-${i}`,
        { takesNewApps: true, architecture },
      ]),
    );

  it('deploys to a cluster with an arm node and warns about it', async () => {
    const { service, clustersService } = build(async () => nodes('x86', 'arm'));
    const result = await service.deployFromYaml('u1', dto(), 'u1@example.com');

    expect(result.operationId).toBe('op-1');
    expect(result.warnings).toEqual([ARM_WARNING]);
    expect(clustersService.liveNodeFacts).toHaveBeenCalledWith('cluster-1');
  });

  it('says nothing on an x86 cluster', async () => {
    const { service } = build(async () => nodes('x86', null));
    const result = await service.deployFromYaml('u1', dto(), 'u1@example.com');

    expect(result.operationId).toBe('op-1');
    expect(result.warnings).toBeUndefined();
  });

  it('deploys without a warning when the cluster could not be asked', async () => {
    const { service } = build(async () => {
      throw new Error('unreachable');
    });
    const result = await service.deployFromYaml('u1', dto(), 'u1@example.com');

    expect(result.operationId).toBe('op-1');
    expect(result.warnings).toBeUndefined();
  });
});
