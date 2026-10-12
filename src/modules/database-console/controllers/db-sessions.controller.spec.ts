jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { DbSessionsController } from './db-sessions.controller';
import { AppAccessGuard } from '../../applications/guards/app-access.guard';
import { AppOwnershipGuard } from '../guards/app-ownership.guard';
import { DATA_DOOR_KEY } from '../../iam/decorators/data-door.decorator';
import { REQUIRED_PERMISSION_KEY } from '../../iam/decorators/require-permission.decorator';
import { OPEN_ON_SHOWCASE_KEY } from '../../iam/decorators/open-on-showcase.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  ACTION_CYCLE_KEY,
  ActionCycleDecl,
} from '../../action-cycle/action-cycle.decorator';
import { auditEntryFor } from '../../audit/audit.middleware';
import { noteDataAccess } from '../../audit/audit-request';

const handler = (name: keyof DbSessionsController) =>
  DbSessionsController.prototype[name] as unknown as object;

const meta = (key: string, name: keyof DbSessionsController): unknown =>
  Reflect.getMetadata(key, handler(name)) ??
  Reflect.getMetadata(key, DbSessionsController);

describe('the active sessions routes', () => {
  it('sit behind the ordinary application guard, not the console guard', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      DbSessionsController,
    ) as unknown[];
    expect(guards).toContain(AppAccessGuard);
    expect(guards).not.toContain(AppOwnershipGuard);
  });

  it('reads the list with app:read through the data door', () => {
    expect(meta(DATA_DOOR_KEY, 'list')).toBe(true);
    expect(meta(REQUIRED_PERMISSION_KEY, 'list')).toBe(IAM_PERMISSION.APP_READ);
    expect(meta(ACTION_CYCLE_KEY, 'list')).toBeUndefined();
    expect(meta(OPEN_ON_SHOWCASE_KEY, 'list')).toBeUndefined();
  });

  it.each(['cancel', 'terminate'] as const)(
    '%s asks app:write, is a data door and pauses an agent for a person',
    (name) => {
      expect(meta(DATA_DOOR_KEY, name)).toBe(true);
      expect(meta(REQUIRED_PERMISSION_KEY, name)).toBe(
        IAM_PERMISSION.APP_WRITE,
      );
      const decl = meta(ACTION_CYCLE_KEY, name) as ActionCycleDecl;
      expect(decl.action).toBe(
        `POST /applications/:id/db/sessions/:pid/${name}`,
      );
      expect(decl.bind).toEqual(['id', 'pid']);
      expect(decl.sentence).toContain('{pid}');
      expect(decl.consequence).toBeTruthy();
    },
  );

  it('pass the session identity to the service', async () => {
    const act = jest.fn(async () => ({}));
    const controller = new DbSessionsController({ act } as never);
    await controller.terminate(
      'db-1',
      42,
      { backendStart: '2026-10-12T07:00:00.123Z' },
      { user: { userId: 'u-1' } } as never,
    );
    expect(act).toHaveBeenCalledWith(
      'db-1',
      42,
      '2026-10-12T07:00:00.123Z',
      'terminate',
      'u-1',
    );
  });

  it('are recorded in the activity register with the database and the pid', () => {
    const req = {
      method: 'POST',
      route: { path: '/api/v1/applications/:id/db/sessions/:pid/terminate' },
      params: { id: 'db-1', pid: '42' },
      user: { userId: 'u-1', email: 'u@example.com' },
      headers: {},
    };
    noteDataAccess(req as never);
    expect(auditEntryFor(req as never, 200)).toMatchObject({
      action: 'POST /applications/:id/db/sessions/:pid/terminate',
      target: { id: 'db-1', pid: '42' },
      dataAccess: true,
      outcome: 'ok',
    });
  });

  it('record a read of the list as a read of data', () => {
    const req = {
      method: 'GET',
      route: { path: '/api/v1/applications/:id/db/sessions' },
      params: { id: 'db-1' },
      user: { userId: 'u-1' },
      headers: {},
    };
    expect(auditEntryFor(req as never, 200)).toBeNull();
    noteDataAccess(req as never);
    expect(auditEntryFor(req as never, 200)).toMatchObject({
      target: { id: 'db-1' },
      dataAccess: true,
    });
  });
});
