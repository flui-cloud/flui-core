import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyStrategy } from '../strategies/api-key.strategy';

/**
 * A `@Public()` route is let through *before* any strategy runs, so `req.user`
 * stays undefined even when the caller presents a perfectly good credential.
 *
 * This is the fact `POST /auth/register` rests on: its "subsequent calls
 * require an authenticated admin" branch reads `req.user?.isAdmin`, which on a
 * public route can never be true. Anyone tempted to restore admin-gated
 * registration by reading the token here would be re-opening the door the same
 * width as `setRole` had it.
 */
describe('JwtAuthGuard — public routes carry no principal', () => {
  function contextWith(headers: Record<string, string>): {
    ctx: ExecutionContext;
    request: { headers: Record<string, string>; user?: unknown };
  } {
    const request = { headers };
    const ctx = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { ctx, request };
  }

  it('lets a public route through without populating req.user', async () => {
    const reflector = {
      getAllAndOverride: () => true,
    } as unknown as Reflector;
    const apiKeyStrategy = {
      validate: jest.fn(),
    } as unknown as ApiKeyStrategy;
    const guard = new JwtAuthGuard(reflector, apiKeyStrategy);

    const { ctx, request } = contextWith({
      authorization: 'Bearer flui_would-have-been-valid',
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
    expect(apiKeyStrategy.validate).not.toHaveBeenCalled();
  });

  it('resolves an API key on a non-public route', async () => {
    const reflector = {
      getAllAndOverride: () => false,
    } as unknown as Reflector;
    const principal = { userId: 'u1', email: 'a@b.c', isAdmin: false };
    const apiKeyStrategy = {
      validate: jest.fn().mockResolvedValue(principal),
    } as unknown as ApiKeyStrategy;
    const guard = new JwtAuthGuard(reflector, apiKeyStrategy);

    const { ctx, request } = contextWith({
      authorization: 'Bearer flui_key',
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toBe(principal);
  });
});
