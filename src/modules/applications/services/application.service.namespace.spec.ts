// The service's import graph reaches ESM-only packages (Kubernetes client, jose via
// jwks-rsa) that ts-jest cannot transform; stub them — this suite touches none of them.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { ApplicationService } from './application.service';
import { CreateApplicationDto } from '../dto/create-application.dto';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { RESERVED_NAMESPACE_ERROR_CODE } from '../utils/reserved-namespace.util';

/**
 * The namespace is the tenancy boundary: an application placed in a
 * platform-owned namespace can mount the platform's own Secrets. `create()` is
 * the one choke point every client path goes through (POST
 * /clusters/:id/applications, deploy-from-build, manifest deploy), so the
 * refusal is asserted there — and asserted to happen before anything persists.
 */
describe('ApplicationService.create — namespace placement', () => {
  const created: Array<Record<string, unknown>> = [];

  const applicationsRepository = {
    create: async (data: Record<string, unknown>) => {
      created.push(data);
      return { id: 'app-1', ...data };
    },
  };
  const resourceProfilesService = {
    getDefaultProfileName: () => 'small',
    resolveResources: () => ({
      cpu: { request: '100m', limit: '500m' },
      memory: { request: '128Mi', limit: '512Mi' },
    }),
  };

  // create() uses the repository (1st) and the resource profiles (7th); the rest
  // of the constructor deps are unused on this path.
  const service = new (ApplicationService as unknown as new (
    ...args: unknown[]
  ) => ApplicationService)(
    applicationsRepository,
    ...new Array(5).fill(undefined),
    resourceProfilesService,
    ...new Array(4).fill(undefined),
  );

  const dto = (k8sNamespace?: string): CreateApplicationDto =>
    ({
      name: 'probe',
      slug: 'probe',
      category: ApplicationCategory.USER,
      sourceType: ApplicationSourceType.DOCKER_IMAGE,
      sourceConfig: { type: 'docker_image', imageRef: 'nginx:1.25' },
      k8sNamespace,
    }) as CreateApplicationDto;

  beforeEach(() => {
    created.length = 0;
  });

  it.each(['flui-system', 'flui-control', 'kube-system', 'build-agents'])(
    'refuses a client-named %s and persists nothing',
    async (ns) => {
      await expect(
        service.create('cluster-1', dto(ns), 'u1', 'guest@try.flui.cloud'),
      ).rejects.toMatchObject({
        response: { code: RESERVED_NAMESPACE_ERROR_CODE },
      });
      expect(created).toHaveLength(0);
    },
  );

  it('accepts an ordinary namespace', async () => {
    await service.create('cluster-1', dto('my-team'), 'u1', 'a@b.com');
    expect(created[0].k8sNamespace).toBe('my-team');
  });

  it('falls back to the caller own namespace when none is given', async () => {
    await service.create('cluster-1', dto(), 'u1', 'guest@try.flui.cloud');
    expect(created[0].k8sNamespace).toBe('user-guest');
  });
});
