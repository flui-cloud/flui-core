jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { CatalogDependencyResolverService } from './catalog-dependency-resolver.service';
import { DependencyMode } from '../enums/dependency-mode.enum';

describe('a dedicated dependency and the pooler', () => {
  it('installs the block without a pooler, since its dependent is wired with the direct host', async () => {
    const installBuildingBlock = jest.fn(async () => {
      throw new Error('stop here');
    });
    const resolver = new CatalogDependencyResolverService(
      {} as never,
      {} as never,
      {} as never,
      { installBuildingBlock } as never,
    );

    await expect(
      resolver.resolveAll(
        [{ ref: 'postgresql', as: 'db' }],
        [{ alias: 'db', mode: DependencyMode.DEDICATED }] as never,
        'c1',
        'u1',
        'u1@example.com',
        { projectId: 'p1' },
      ),
    ).rejects.toThrow('stop here');

    expect(installBuildingBlock).toHaveBeenCalledWith(
      'postgresql',
      'c1',
      'u1',
      'u1@example.com',
      'p1',
      { pooler: false },
    );
  });
});
