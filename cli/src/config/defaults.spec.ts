import { getRecommendedServerType, getSupportedRegions } from './defaults';

describe('CLI defaults', () => {
  it('places Scaleway clusters in Milan', () => {
    expect(getSupportedRegions('scaleway')).toContain('it-mil');
  });

  it('recommends a type Milan sells, and keeps the usual one elsewhere', () => {
    expect(getRecommendedServerType('scaleway', 'it-mil')).toBe(
      'BASIC3-X2C-8G',
    );
    expect(getRecommendedServerType('scaleway', 'fr-par')).toBe('DEV1-M');
    expect(getRecommendedServerType('scaleway')).toBe('DEV1-M');
    expect(getRecommendedServerType('hetzner', 'it-mil')).toBe('cx23');
    expect(getRecommendedServerType('hetzner', 'ash')).toBe('cpx21');
    expect(getRecommendedServerType('hetzner', 'sin')).toBe('cpx22');
    expect(getRecommendedServerType('hetzner', 'nbg1')).toBe('cx23');
  });
});
