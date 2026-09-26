import { CatalogAppType } from '../enums/catalog-app-type.enum';
import { catalogExposure, exposureRefusal } from './catalog-exposure.util';

const standalone = { type: CatalogAppType.STANDALONE };
const composed = { type: CatalogAppType.COMPOSED };

describe('catalog exposure', () => {
  it('makes a single-component app internal when asked', () => {
    expect(
      catalogExposure(standalone, CatalogAppType.STANDALONE, 'internal')
        .effective,
    ).toBe('internal');
    expect(
      exposureRefusal(standalone, CatalogAppType.STANDALONE, 'internal'),
    ).toBeNull();
  });

  it('refuses internal where the app would stay public, instead of building it public in silence', () => {
    expect(
      exposureRefusal(composed, CatalogAppType.COMPOSED, 'internal'),
    ).toContain('several components');
    expect(
      exposureRefusal(
        { ...standalone, privatizable: false },
        CatalogAppType.STANDALONE,
        'internal',
      ),
    ).toContain('privatizable: false');
  });

  it('refuses public for an app the manifest keeps internal', () => {
    expect(
      exposureRefusal(
        { ...standalone, exposure: 'internal' },
        CatalogAppType.STANDALONE,
        'public',
      ),
    ).toContain('cannot be made public');
  });

  it('asks nothing when no exposure is requested', () => {
    expect(
      exposureRefusal(composed, CatalogAppType.COMPOSED, undefined),
    ).toBeNull();
  });
});
