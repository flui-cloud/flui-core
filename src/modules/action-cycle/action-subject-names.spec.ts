import { ActionSubjectNames } from './action-subject-names';
import { subjectTableOf } from './action-cycle.core';

const ID = '9f68e8cd-1259-44eb-bcaa-74beeef24ba1';

describe('a request names its subject', () => {
  it('knows which routes name an application, a key or a cluster', () => {
    expect(subjectTableOf('DELETE /applications/:id/install')).toBe(
      'applications',
    );
    expect(subjectTableOf('PATCH /auth/api-keys/:id/scopes')).toBe('api_keys');
    expect(subjectTableOf('POST /infrastructure/clusters/:id/workers')).toBe(
      'infrastructure_clusters',
    );
    expect(subjectTableOf('DELETE /app-migrations/:id')).toBeUndefined();
  });

  it('puts the name where the id was', async () => {
    const query = jest.fn().mockResolvedValue([{ name: 'flui-managed' }]);
    const names = new ActionSubjectNames({ query } as never);
    await expect(
      names.label('DELETE /applications/:id/install', { id: ID }),
    ).resolves.toEqual({ id: 'flui-managed' });
    expect(query.mock.calls[0][1]).toEqual([ID]);
  });

  it('keeps the id when there is no name, no row, or no database', async () => {
    const none = new ActionSubjectNames({
      query: jest.fn().mockResolvedValue([]),
    } as never);
    const down = new ActionSubjectNames({
      query: jest.fn().mockRejectedValue(new Error('x')),
    } as never);
    await expect(
      none.label('DELETE /applications/:id/install', { id: ID }),
    ).resolves.toEqual({ id: ID });
    await expect(
      down.label('DELETE /applications/:id/install', { id: ID }),
    ).resolves.toEqual({ id: ID });
  });

  it('never queries with something that is not an id', async () => {
    const query = jest.fn();
    const names = new ActionSubjectNames({ query } as never);
    await names.label('DELETE /applications/:id/install', { id: "x'; drop" });
    await names.label('DELETE /app-migrations/:id', { id: ID });
    expect(query).not.toHaveBeenCalled();
  });
});
