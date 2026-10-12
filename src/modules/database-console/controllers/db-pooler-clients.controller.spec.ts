jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { DbPoolerClientsController } from './db-pooler-clients.controller';
import { AppAccessGuard } from '../../applications/guards/app-access.guard';
import { PlatformFoundationGuard } from '../guards/platform-foundation.guard';
import { DATA_DOOR_KEY } from '../../iam/decorators/data-door.decorator';
import { REQUIRED_PERMISSION_KEY } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  ACTION_CYCLE_KEY,
  ActionCycleDecl,
} from '../../action-cycle/action-cycle.decorator';
import { auditEntryFor } from '../../audit/audit.middleware';
import { noteDataAccess } from '../../audit/audit-request';

const close = DbPoolerClientsController.prototype.close as unknown as object;

describe('closing a pooled connection', () => {
  it('sits behind the foundation fence and the ordinary application guard', () => {
    expect(
      Reflect.getMetadata('__guards__', DbPoolerClientsController),
    ).toEqual([PlatformFoundationGuard, AppAccessGuard]);
  });

  it('asks app:write, is a data door and pauses an agent for a person', () => {
    expect(Reflect.getMetadata(DATA_DOOR_KEY, DbPoolerClientsController)).toBe(
      true,
    );
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, close)).toBe(
      IAM_PERMISSION.APP_WRITE,
    );
    const decl = Reflect.getMetadata(
      ACTION_CYCLE_KEY,
      close,
    ) as ActionCycleDecl;
    expect(decl).toMatchObject({
      action: 'POST /applications/:id/db/pooler/clients/:clientId/close',
      bind: ['id', 'clientId'],
      sentence: 'close pooled connection {clientId} of database {id}',
    });
    expect(decl.consequence).toBeTruthy();
  });

  it('hands the client identity to the service', async () => {
    const closePoolerClient = jest.fn(async () => ({}));
    const controller = new DbPoolerClientsController({
      closePoolerClient,
    } as never);
    await controller.close(
      'db-1',
      5,
      { pod: 'pg-pooler-1', connectTime: '2026-10-12 07:00:00 UTC' },
      { user: { userId: 'u-1' } } as never,
    );
    expect(closePoolerClient).toHaveBeenCalledWith(
      'db-1',
      {
        pod: 'pg-pooler-1',
        clientId: 5,
        connectTime: '2026-10-12 07:00:00 UTC',
      },
      'u-1',
    );
  });

  it('is recorded with the database and the client id', () => {
    const req = {
      method: 'POST',
      route: {
        path: '/api/v1/applications/:id/db/pooler/clients/:clientId/close',
      },
      params: { id: 'db-1', clientId: '5' },
      user: { userId: 'u-1' },
      headers: {},
    };
    noteDataAccess(req as never);
    expect(auditEntryFor(req as never, 200)).toMatchObject({
      action: 'POST /applications/:id/db/pooler/clients/:clientId/close',
      target: { id: 'db-1', clientId: '5' },
      dataAccess: true,
    });
  });
});
