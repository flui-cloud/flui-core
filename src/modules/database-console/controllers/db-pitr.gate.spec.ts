jest.mock('@kubernetes/client-node', () => ({}));

import { ForbiddenException } from '@nestjs/common';
import { DbPitrController } from './db-pitr.controller';

/** F-104: a point-in-time restore creates an application and passes the creation gate. */
describe('restoring a database to a point in time', () => {
  const restore = jest.fn(async () => ({ installId: 'new' }));
  const assertCanCreate = jest.fn(
    async (_u: unknown, target: { clusterId: string }) => {
      if (target.clusterId !== 'guest-cluster')
        throw new ForbiddenException('outside your area');
      return {};
    },
  );
  const controller = new DbPitrController(
    { restore } as never,
    { assertCanCreate } as never,
    {
      findById: jest.fn(async () => ({
        id: 'db',
        clusterId: 'guest-cluster',
        projectId: null,
      })),
    } as never,
  );
  const req = { user: { userId: 'guest' } } as never;

  it('refuses a cluster outside the caller’s area', async () => {
    await expect(
      controller.restore(
        'db',
        { name: 'copy', clusterId: 'control' } as never,
        req,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(restore).not.toHaveBeenCalled();
  });

  it('asks the gate for the source’s cluster when none is named', async () => {
    await expect(
      controller.restore('db', { name: 'copy' } as never, req),
    ).resolves.toEqual({ installId: 'new' });
    expect(assertCanCreate).toHaveBeenLastCalledWith(
      { userId: 'guest' },
      { clusterId: 'guest-cluster', projectId: undefined },
    );
  });
});
