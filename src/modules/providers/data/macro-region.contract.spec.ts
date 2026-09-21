import { MACRO_REGIONS, macroRegionOf } from '@flui-cloud/infra';

/**
 * The macro-region table lives in `@flui-cloud/infra` and no longer here, so
 * what is worth testing from this side is the seam, not the table.
 *
 * It caught its own absence once already: the first publish shipped the file
 * without exporting it from the package root, so every consumer compiled and
 * `macroRegionOf` was `undefined` at run time.
 */
describe('the macro-region this API depends on', () => {
  it('is exported by the package, not merely shipped inside it', () => {
    expect(typeof macroRegionOf).toBe('function');
    expect(MACRO_REGIONS).toContain('europe');
    expect(MACRO_REGIONS).toContain('oceania');
  });

  it('places every country the three providers sell from', () => {
    const countries = {
      DE: 'europe',
      FI: 'europe',
      NL: 'europe',
      PL: 'europe',
      FR: 'europe',
      IT: 'europe',
      GB: 'europe',
      US: 'north-america',
      CA: 'north-america',
      SG: 'asia',
      AU: 'oceania',
    };

    for (const [code, macro] of Object.entries(countries)) {
      expect(macroRegionOf(code)).toBe(macro);
    }
  });

  it('says nothing rather than guessing at a country it does not know', () => {
    expect(macroRegionOf('ZZ')).toBeNull();
    expect(macroRegionOf('')).toBeNull();
  });
});
