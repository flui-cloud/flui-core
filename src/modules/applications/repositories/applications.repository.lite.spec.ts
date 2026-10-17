import { In, IsNull } from 'typeorm';
import { ApplicationsRepository } from './applications.repository';

describe('the lite application lookups', () => {
  function over() {
    const inner = {
      findOne: jest.fn(async () => ({ id: 'a1' })),
      findBy: jest.fn(async () => [{ id: 'a1' }]),
    };
    return { repo: new ApplicationsRepository(inner as never), inner };
  }

  it('reads one live row without joining revisions or resources', async () => {
    const { repo, inner } = over();
    await repo.findByIdLite('a1');
    expect(inner.findOne).toHaveBeenCalledWith({
      where: { id: 'a1', deletedAt: IsNull() },
    });
  });

  it('keeps the full lookup joining both', async () => {
    const { repo, inner } = over();
    await repo.findById('a1');
    expect(inner.findOne).toHaveBeenCalledWith({
      where: { id: 'a1', deletedAt: IsNull() },
      relations: ['revisions', 'appResources'],
    });
  });

  it('reads many live rows in one query', async () => {
    const { repo, inner } = over();
    await repo.findByIdsLite(['a1', 'a2']);
    expect(inner.findBy).toHaveBeenCalledWith({
      id: In(['a1', 'a2']),
      deletedAt: IsNull(),
    });
  });

  it('asks nothing for no ids', async () => {
    const { repo, inner } = over();
    expect(await repo.findByIdsLite([])).toEqual([]);
    expect(inner.findBy).not.toHaveBeenCalled();
  });
});
