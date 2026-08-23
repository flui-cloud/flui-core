import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import {
  CURRENT_API_KEY_ID,
  ApiKeyStrategy,
} from '../strategies/api-key.strategy';

/**
 * A `@Public()` route is let through *before* any strategy runs, so `req.user`
 * stays undefined even when the caller presents a perfectly good credential.
 *
 * `POST /auth/register` was the route this fact was written for, and it is
 * gone — but the fact outlives it and guards every remaining
 * `@Public()` route: a branch that reads `req.user?.isAdmin` here can never be
 * true. Anyone tempted to gate a public route by reading the token would be
 * re-opening the door the same width as `setRole` had it.
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
      validateWithRecord: jest.fn(),
    } as unknown as ApiKeyStrategy;
    const guard = new JwtAuthGuard(reflector, apiKeyStrategy);

    const { ctx, request } = contextWith({
      authorization: 'Bearer flui_would-have-been-valid',
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
    expect(apiKeyStrategy.validateWithRecord).not.toHaveBeenCalled();
  });

  it('resolves an API key on a non-public route', async () => {
    const reflector = {
      getAllAndOverride: () => false,
    } as unknown as Reflector;
    const principal = { userId: 'u1', email: 'a@b.c', isAdmin: false };
    const apiKeyStrategy = {
      validateWithRecord: jest
        .fn()
        .mockResolvedValue({ user: principal, keyId: 'key-1' }),
    } as unknown as ApiKeyStrategy;
    const guard = new JwtAuthGuard(reflector, apiKeyStrategy);

    const { ctx, request } = contextWith({
      authorization: 'Bearer flui_key',
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toBe(principal);
    // Which row authenticated the call, parked on the request and not on the
    // principal — `/auth/me` returns `req.user` verbatim.
    expect(
      (request as unknown as Record<symbol, string>)[CURRENT_API_KEY_ID],
    ).toBe('key-1');
  });
});
