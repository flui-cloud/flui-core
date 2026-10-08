// The service's import graph reaches ESM-only packages (Kubernetes client, jose via
// jwks-rsa) that ts-jest cannot transform; stub them — this suite touches none of them.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { ApplicationService } from './application.service';
import { CreateApplicationDto } from '../dto/create-application.dto';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { CLIENT_NAMESPACE_ERROR_CODE } from '../utils/reserved-namespace.util';
import {
  NAMESPACE_OWNER_UNKNOWN_ERROR_CODE,
  ownerUnknown,
} from '../utils/k8s-namespace.util';

/**
 * The namespace is the tenancy boundary: whoever names it chooses whose
 * Secrets, ConfigMaps and volumes the workload lands beside. `create()` is the
 * one choke point every client path goes through, so the rules are asserted
 * there, and asserted to hold before anything persists: a client never names
 * a namespace, and the one an application gets is its project's.
 *
 * The DTO does not declare `k8sNamespace`, but the validation pipe keeps
 * undeclared properties, so the body can still carry one: the tests inject it
 * the same way a raw client would.
 */
describe('ApplicationService.create — namespace placement', () => {
  const created: Array<Record<string, unknown>> = [];
  const asked: Array<Record<string, unknown>> = [];

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
  const projects = {
    placementFor: async (input: { projectId?: string; userId?: string }) => {
      asked.push(input);
      if (!input.projectId && !input.userId) throw ownerUnknown();
      const slug = input.projectId ? 'web-team' : `personal-${input.userId}`;
      return {
        project: { id: input.projectId ?? `personal-of-${input.userId}`, slug },
        namespace: `p-${slug}`,
      };
    },
  };

  // create() uses the repository (1st), the resource profiles (7th) and the
  // projects (12th); the rest of the constructor deps are unused on this path.
  const service = new (ApplicationService as unknown as new (
    ...args: unknown[]
  ) => ApplicationService)(
    applicationsRepository,
    ...new Array(5).fill(undefined),
    resourceProfilesService,
    ...new Array(4).fill(undefined),
    projects,
  );

  const dto = (
    over: Partial<CreateApplicationDto> = {},
  ): CreateApplicationDto =>
    ({
      name: 'probe',
      slug: 'probe',
      category: ApplicationCategory.USER,
      sourceType: ApplicationSourceType.DOCKER_IMAGE,
      sourceConfig: { type: 'docker_image', imageRef: 'nginx:1.25' },
      ...over,
    }) as CreateApplicationDto;

  beforeEach(() => {
    created.length = 0;
    asked.length = 0;
  });

  it.each([
    ['p-someone-else', "another project's namespace"],
    ['my-team', 'an ordinary, non-reserved namespace'],
    ['flui-system', 'a platform-reserved namespace'],
    ['', 'an empty string'],
  ])('refuses a client-named %s (%s) and persists nothing', async (ns) => {
    const body = dto();
    (body as { k8sNamespace?: string }).k8sNamespace = ns;
    await expect(service.create('cluster-1', body, 'u1')).rejects.toMatchObject(
      {
        response: { code: CLIENT_NAMESPACE_ERROR_CODE },
      },
    );
    expect(created).toHaveLength(0);
  });

  it("lands an application without a project in its creator's personal project", async () => {
    await service.create('cluster-1', dto(), 'u1');

    expect(asked).toEqual([{ projectId: undefined, userId: 'u1' }]);
    expect(created[0].k8sNamespace).toBe('p-personal-u1');
    expect(created[0].projectId).toBe('personal-of-u1');
  });

  it('lands an application in the namespace of the project it names', async () => {
    await service.create('cluster-1', dto({ projectId: 'team-1' }), 'u1');

    expect(created[0].k8sNamespace).toBe('p-web-team');
    expect(created[0].projectId).toBe('team-1');
  });

  /**
   * `default` is a namespace no project owns, so an application quietly placed
   * there escapes every quota, network policy and sweep bound to a project's
   * namespace. The refusal is asserted twice over: that it happens at all, and
   * that nothing is written when it does.
   */
  it('refuses to place an application for nobody, and never falls back to "default"', async () => {
    await expect(
      service.create('cluster-1', dto(), undefined),
    ).rejects.toMatchObject({
      response: { code: NAMESPACE_OWNER_UNKNOWN_ERROR_CODE },
    });
    expect(created).toHaveLength(0);
  });
});
