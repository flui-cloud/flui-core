jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { CatalogDependencyResolverService } from './catalog-dependency-resolver.service';
import { DependencyMode } from '../enums/dependency-mode.enum';

describe('a dedicated dependency and the control-plane node', () => {
  const resolve = async (allowMasterPlacement?: boolean) => {
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
        [{ ref: 'kafka', as: 'kafka' }],
        [{ alias: 'kafka', mode: DependencyMode.DEDICATED }] as never,
        'c1',
        'u1',
        'u1@example.com',
        { projectId: 'p1', allowMasterPlacement },
      ),
    ).rejects.toThrow('stop here');
    return (installBuildingBlock.mock.calls[0] as unknown[])[6];
  };

  it('goes where the application that needs it was allowed to go', async () => {
    expect(await resolve(true)).toBe(true);
  });

  it('stays off it unless the dependent was allowed there', async () => {
    expect(await resolve(false)).toBe(false);
    expect(await resolve()).toBe(false);
  });
});
