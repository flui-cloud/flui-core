import { ForbiddenException } from '@nestjs/common';
import {
  ApplicationsRepository,
  PROJECTION_NOT_REMOVABLE_CODE,
} from './applications.repository';

/**
 * Flui does not own the lifecycle of what it discovered.
 *
 * The row for zitadel or the platform Postgres is a projection: the bootstrap
 * put the thing on the cluster, discovery mirrored it so logs, metrics and
 * topology have something to read. Deleting the row deletes the reading, not
 * the thing — and the next discovery pass writes it straight back. Refusing on
 * `systemProtected` said none of that; it named a flag Flui sets on itself.
 */
describe('a discovered row is a projection, not a possession', () => {
  function repoOver(rows: Record<string, Record<string, unknown>>) {
    const update = jest.fn(async () => undefined);
    const remove = jest.fn(async () => undefined);
    const inner = {
      findOne: jest.fn(
        async ({ where }: { where: { id: string } }) => rows[where.id] ?? null,
      ),
      update,
      delete: remove,
    };
    return { repo: new ApplicationsRepository(inner as never), update, remove };
  }

  const platform = {
    id: 'p1',
    slug: 'zitadel',
    ownerKind: 'platform',
    ownerRef: 'flui-core',
  };
  const mine = { id: 'a1', slug: 'my-app', ownerKind: null, ownerRef: null };

  it('refuses to soft-delete a row the platform declares', async () => {
    const { repo, update } = repoOver({ p1: platform });
    await expect(repo.softDelete('p1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses to hard-delete it too', async () => {
    const { repo, remove } = repoOver({ p1: platform });
    await expect(repo.delete('p1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(remove).not.toHaveBeenCalled();
  });

  it('says why, and names who declares it', async () => {
    const { repo } = repoOver({ p1: platform });
    const error = await repo.softDelete('p1').catch((e) => e);
    const body = (error as ForbiddenException).getResponse() as {
      code: string;
      message: string;
    };
    expect(body.code).toBe(PROJECTION_NOT_REMOVABLE_CODE);
    expect(body.message).toContain('platform bootstrap');
    expect(body.message).toContain('flui-core');
    expect(body.message).not.toContain('systemProtected');
  });

  it('leaves an ordinary application removable', async () => {
    const { repo, update } = repoOver({ a1: mine });
    await expect(repo.softDelete('a1')).resolves.toBeUndefined();
    expect(update).toHaveBeenCalled();
  });

  it('does not turn a missing row into a refusal', async () => {
    const { repo, remove } = repoOver({});
    await expect(repo.delete('gone')).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalled();
  });
});
