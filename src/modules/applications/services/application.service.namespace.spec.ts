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
import { NAMESPACE_OWNER_UNKNOWN_ERROR_CODE } from '../utils/k8s-namespace.util';

/**
 * The namespace is the tenancy boundary: whoever names it chooses whose
 * Secrets, ConfigMaps and volumes the workload lands beside. `create()` is the
 * one choke point every client path goes through (POST
 * /clusters/:id/applications, deploy-from-build, manifest deploy), so the
 * refusal is asserted there — and asserted to happen before anything persists.
 *
 * The DTO no longer declares the field, but the validation pipe keeps
 * undeclared properties, so the body can still carry one: the tests inject it
 * the same way a raw client would.
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

  const dto = (): CreateApplicationDto =>
    ({
      name: 'probe',
      slug: 'probe',
      category: ApplicationCategory.USER,
      sourceType: ApplicationSourceType.DOCKER_IMAGE,
      sourceConfig: { type: 'docker_image', imageRef: 'nginx:1.25' },
    }) as CreateApplicationDto;

  beforeEach(() => {
    created.length = 0;
  });

  it.each([
    ['user-guest-1f234701', "another tenant's namespace"],
    ['my-team', 'an ordinary, non-reserved namespace'],
    ['flui-system', 'a platform-reserved namespace'],
    ['', 'an empty string'],
  ])('refuses a client-named %s (%s) and persists nothing', async (ns) => {
    const body = dto();
    (body as { k8sNamespace?: string }).k8sNamespace = ns;
    await expect(
      service.create('cluster-1', body, 'u1', 'guest@try.flui.cloud'),
    ).rejects.toMatchObject({
      response: { code: CLIENT_NAMESPACE_ERROR_CODE },
    });
    expect(created).toHaveLength(0);
  });

  it('derives the namespace from the caller and never from the request', async () => {
    await service.create('cluster-1', dto(), 'u1', 'guest@try.flui.cloud');
    expect(created[0].k8sNamespace).toBe('user-guest');
  });

  /**
   * The regression this pins is not a leak, it is a survival: `default` is a
   * namespace no tenancy owns, so an application quietly placed there escapes
   * the `ResourceQuota` and `LimitRange` bound to the tenancy namespace, the
   * `NetworkPolicy` that isolates it, the `noindex` middleware, the sandbox
   * branch of `EndpointHostGuardService` (which asks
   * `sandboxTenants.exists({clusterId, namespace})` before it constrains a
   * hostname) and — the one that outlives everything — the expiry sweep in
   * `SandboxTenantService`, which deletes rows and namespaces by
   * `k8sNamespace`. Five protections, disarmed by one silent `: 'default'`.
   *
   * So the refusal is asserted twice over: that it happens at all, and that
   * nothing is written when it does.
   */
  it('refuses to place an application when the caller has no email, and never falls back to "default"', async () => {
    await expect(
      service.create('cluster-1', dto(), 'u1', undefined),
    ).rejects.toMatchObject({
      response: { code: NAMESPACE_OWNER_UNKNOWN_ERROR_CODE },
    });
    expect(created).toHaveLength(0);
  });

  it.each([[''], [null]])(
    'refuses an empty-ish email (%p) the same way, rather than deriving a namespace from it',
    async (email) => {
      await expect(
        service.create(
          'cluster-1',
          dto(),
          'u1',
          email as unknown as string | undefined,
        ),
      ).rejects.toMatchObject({
        response: { code: NAMESPACE_OWNER_UNKNOWN_ERROR_CODE },
      });
      expect(created).toHaveLength(0);
    },
  );
});
