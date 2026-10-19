jest.mock('@kubernetes/client-node', () => ({}));

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { DbConsoleController } from './db-console.controller';
import {
  AppOwnershipGuard,
  CONSOLE_READER,
} from '../guards/app-ownership.guard';
import { PlatformFoundationGuard } from '../guards/platform-foundation.guard';
import { OPEN_ON_SHOWCASE_KEY } from '../../iam/decorators/open-on-showcase.decorator';
import { DATA_DOOR_KEY } from '../../iam/decorators/data-door.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { SHOWCASE_TAG } from '../../iam/constants/iam-showcase';

type App = {
  id: string;
  userId: string | null;
  tags?: string[];
  ownerKind?: string;
};

const APPS: Record<string, App> = {
  mine: { id: 'mine', userId: 'guest-a', ownerKind: 'user' },
  theirs: { id: 'theirs', userId: 'guest-b', ownerKind: 'user' },
  shown: {
    id: 'shown',
    userId: 'operator',
    ownerKind: 'user',
    tags: [SHOWCASE_TAG],
  },
};

function guard() {
  const appAccess = {
    can: async (user: { userId: string }, action: string, app: App) => {
      if (app.userId === user.userId) return true;
      if (app.tags?.includes(SHOWCASE_TAG))
        return action === IAM_PERMISSION.APP_READ;
      return false;
    },
  };
  return new AppOwnershipGuard(
    { findById: async (id: string) => APPS[id] ?? null } as never,
    {
      resolveAccess: async () => ({
        isSandbox: true,
        globalPermissions: new Set(),
      }),
    } as never,
    appAccess as never,
    new Reflector(),
  );
}

function assistCall(appId: string, userId: string) {
  const req: Record<string | symbol, unknown> = {
    params: { id: appId },
    user: { userId, isAdmin: false },
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => DbConsoleController.prototype.assist,
    getClass: () => DbConsoleController,
  } as unknown as ExecutionContext;
  return { req, ctx };
}

function controller() {
  const queryService = { runQuery: jest.fn(async () => ({})) };
  const assistService = { assist: jest.fn(async () => ({})) };
  return {
    queryService,
    assistService,
    ctl: new DbConsoleController(queryService as never, assistService as never),
  };
}

describe('SQL copilot reach for a guest', () => {
  it('the copilot route sits behind the same console gates as the SQL runner', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, DbConsoleController);
    expect(guards).toEqual([PlatformFoundationGuard, AppOwnershipGuard]);
    expect(Reflect.getMetadata(DATA_DOOR_KEY, DbConsoleController)).toBe(true);
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        DbConsoleController.prototype.assist,
      ),
    ).toBeUndefined();
  });

  it("refuses another guest's database", async () => {
    const { ctx } = assistCall('theirs', 'guest-a');
    await expect(guard().canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('admits a showcase database only as a reader', async () => {
    expect(
      Reflect.getMetadata(
        OPEN_ON_SHOWCASE_KEY,
        DbConsoleController.prototype.assist,
      ),
    ).toBe(true);
    const { req, ctx } = assistCall('shown', 'guest-a');
    await expect(guard().canActivate(ctx)).resolves.toBe(true);
    expect(req[CONSOLE_READER]).toBe(true);
  });

  it("lets a guest into their own area's database as its owner", async () => {
    const { req, ctx } = assistCall('mine', 'guest-a');
    await expect(guard().canActivate(ctx)).resolves.toBe(true);
    expect(req[CONSOLE_READER]).toBeUndefined();
  });

  it('a reader copilot call introspects as the reader and spends as the caller', async () => {
    const { ctl, assistService } = controller();
    await ctl.assist('shown', { prompt: 'q', model: 'x' } as never, {
      user: { userId: 'guest-a' } as never,
      [CONSOLE_READER]: true,
    });
    expect(assistService.assist).toHaveBeenCalledWith(
      { dbInstallId: 'shown', fluiUserId: 'guest-a', access: 'reader' },
      'q',
      undefined,
      { model: 'x', provider: undefined, connectionId: undefined },
    );
  });

  it('a reader always runs read-only, whatever the body asks', async () => {
    const { ctl, queryService } = controller();
    await ctl.query(
      'shown',
      { sql: 'DELETE FROM t', readOnly: false, limit: 50_000 } as never,
      { user: { userId: 'guest-a' } as never, [CONSOLE_READER]: true },
    );
    expect(queryService.runQuery).toHaveBeenCalledWith(
      expect.objectContaining({ access: 'reader' }),
      'DELETE FROM t',
      { readOnly: true, statementTimeoutMs: 5_000, maxRows: 1000 },
    );
  });

  it('an owner runs read-only unless the body turns it off', async () => {
    const { ctl, queryService } = controller();
    await ctl.query('mine', { sql: 'SELECT 1' } as never, {
      user: { userId: 'guest-a' } as never,
    });
    expect(queryService.runQuery).toHaveBeenCalledWith(
      expect.objectContaining({ access: 'owner' }),
      'SELECT 1',
      expect.objectContaining({ readOnly: true }),
    );
  });
});
