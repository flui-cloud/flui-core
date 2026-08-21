import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { SandboxProjectionInterceptor } from './sandbox-projection.interceptor';
import { SANDBOX_GUEST_REQUEST } from '../guards/sandbox-fence.guard';
import { SandboxScopeService } from '../services/sandbox-scope.service';

const CLUSTERS = [
  { id: 'own', name: 'a', masterIpAddress: '10.0.0.1', nodes: [] },
  { id: 'other', name: 'b', masterIpAddress: '10.0.0.9', nodes: [] },
];

const headers: Record<string, string> = {};

function context(req: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;
}

const handler = (body: unknown): CallHandler =>
  ({ handle: () => of(body) }) as CallHandler;

describe('SandboxProjectionInterceptor', () => {
  const scopes = {
    resolve: jest.fn().mockResolvedValue({
      userId: 'guest-1',
      clusterId: 'own',
      projectIds: new Set<string>(),
    }),
  } as unknown as SandboxScopeService;

  const interceptor = new SandboxProjectionInterceptor(scopes);

  beforeEach(() => jest.clearAllMocks());

  it('narrows the response for a guest', async () => {
    const req = {
      method: 'GET',
      path: '/api/v1/infrastructure/clusters',
      route: { path: '/api/v1/infrastructure/clusters' },
      [SANDBOX_GUEST_REQUEST]: { userId: 'guest-1' },
    };

    const out = (await firstValueFrom(
      interceptor.intercept(context(req), handler(CLUSTERS)),
    )) as Array<Record<string, unknown>>;

    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty('masterIpAddress');
  });

  // The declaration is the whole point of the level system: nothing downstream
  // should have to guess how much of an area it is looking at.
  it.each([
    ['/api/v1/catalog', 'full'],
    ['/api/v1/infrastructure/clusters/c1/nodes', 'read-only'],
  ])('declares the level of %s as %s', async (path, level) => {
    const req = {
      method: 'GET',
      path,
      route: { path },
      params: {},
      [SANDBOX_GUEST_REQUEST]: { userId: 'guest-1' },
    };
    await firstValueFrom(interceptor.intercept(context(req), handler([])));
    expect(headers['X-Flui-Sandbox-Level']).toBe(level);
  });

  // The half that cannot be proven from a guest's session: everyone else must
  // read the API exactly as they did before the fence gained a second half.
  it('returns a non-guest response untouched, and reads nothing to do it', async () => {
    const req = {
      method: 'GET',
      path: '/api/v1/infrastructure/clusters',
      route: { path: '/api/v1/infrastructure/clusters' },
    };

    const out = await firstValueFrom(
      interceptor.intercept(context(req), handler(CLUSTERS)),
    );

    expect(out).toBe(CLUSTERS);
    expect(scopes.resolve).not.toHaveBeenCalled();
  });

  it('leaves a guest response alone on a route with no projection', async () => {
    const req = {
      method: 'GET',
      path: '/api/v1/catalog',
      route: { path: '/api/v1/catalog' },
      [SANDBOX_GUEST_REQUEST]: { userId: 'guest-1' },
    };

    const body = { entries: [] };
    expect(
      await firstValueFrom(interceptor.intercept(context(req), handler(body))),
    ).toBe(body);
    expect(scopes.resolve).not.toHaveBeenCalled();
  });

  it('ignores non-http contexts', async () => {
    const ctx = { getType: () => 'ws' } as unknown as ExecutionContext;
    const body = { ping: true };
    expect(
      await firstValueFrom(interceptor.intercept(ctx, handler(body))),
    ).toBe(body);
  });
});
