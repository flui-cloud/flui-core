import { ExecutionContext } from '@nestjs/common';
import { SandboxFenceGuard } from './sandbox-fence.guard';

describe('SandboxFenceGuard and what counts as a guest acting', () => {
  const contextFor = (method: string, path: string): ExecutionContext =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          method,
          path: `/api/v1${path}`,
          route: { path: `/api/v1${path}` },
          user: {
            userId: 'u1',
            email: 'u1@example.com',
            isAdmin: false,
            role: 'user',
          },
        }),
      }),
    }) as unknown as ExecutionContext;

  const build = () => {
    const touch = jest.fn(async () => undefined);
    const guard = new SandboxFenceGuard(
      { resolveAccess: async () => ({ isSandbox: true }) } as never,
      { touch } as never,
    );
    return { guard, touch };
  };

  it('counts something the guest does', async () => {
    const { guard, touch } = build();
    await guard.canActivate(contextFor('POST', '/sandbox/keep'));
    expect(touch).toHaveBeenCalledWith('u1');
  });

  it('does not count a read, which an open tab makes on its own', async () => {
    const { guard, touch } = build();
    await guard.canActivate(contextFor('GET', '/sandbox/session'));
    expect(touch).not.toHaveBeenCalled();
  });
});
