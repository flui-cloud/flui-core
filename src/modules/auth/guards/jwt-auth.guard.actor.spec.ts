import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyStrategy } from '../strategies/api-key.strategy';
import { currentActor, runWithActorContext } from '../utils/actor-context';

/**
 * The guard is the single writer of the request's actor, because it is the only
 * place that holds both halves at once: the principal, and the id of the key row
 * that authenticated it. Everything downstream reads; nothing re-derives.
 */
describe('JwtAuthGuard — the actor of the request', () => {
  const contextWith = (headers: Record<string, string>) => {
    const request = { headers };
    return {
      request,
      ctx: {
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
    };
  };

  const guardFor = (user: unknown) =>
    new JwtAuthGuard(
      { getAllAndOverride: () => false } as unknown as Reflector,
      {
        validateWithRecord: jest
          .fn()
          .mockResolvedValue({ user, keyId: 'key-1' }),
      } as unknown as ApiKeyStrategy,
    );

  it('publishes an agent key as an agent, with the key it came from', async () => {
    const guard = guardFor({
      userId: 'u1',
      email: 'a@b.c',
      // A key is issued AS its principal and inherits its isAdmin: without the
      // scopes below, this row would be indistinguishable from the owner's own.
      isAdmin: true,
      scopes: ['mcp:app:read'],
    });
    const { ctx } = contextWith({ authorization: 'Bearer flui_key' });

    const seen = await runWithActorContext(async () => {
      await guard.canActivate(ctx);
      return currentActor();
    });
    expect(seen).toEqual({ kind: 'agent', keyId: 'key-1' });
  });

  it('publishes an unscoped key as a key', async () => {
    const guard = guardFor({ userId: 'u1', email: 'a@b.c' });
    const { ctx } = contextWith({ authorization: 'Bearer flui_key' });

    const seen = await runWithActorContext(async () => {
      await guard.canActivate(ctx);
      return currentActor();
    });
    expect(seen).toEqual({ kind: 'key', keyId: 'key-1' });
  });

  it('publishes nothing for a public route', async () => {
    const guard = new JwtAuthGuard(
      { getAllAndOverride: () => true } as unknown as Reflector,
      { validateWithRecord: jest.fn() } as unknown as ApiKeyStrategy,
    );
    const { ctx } = contextWith({ authorization: 'Bearer flui_key' });

    const seen = await runWithActorContext(async () => {
      await guard.canActivate(ctx);
      return currentActor();
    });
    expect(seen).toBeUndefined();
  });
});
