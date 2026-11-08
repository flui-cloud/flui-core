import { HaTopology, resolveHaTopology } from './ha-topology';

const hetzner: HaTopology = {
  region: 'eu-central',
  zones: ['fsn1', 'nbg1', 'hel1'],
  dataZones: ['fsn1', 'nbg1'],
  validated: true,
  measured: true,
};

describe('which highly available layout applies to a cluster', () => {
  it('takes the layout Flui validated for the region', () => {
    expect(resolveHaTopology([hetzner], 'eu-central', ['fsn1'])).toEqual({
      topology: hetzner,
    });
  });

  it('refuses a region nobody validated, and says it can be forced', () => {
    const r = resolveHaTopology([hetzner], 'fr-par', ['fr-par-1']);
    expect(r.topology).toBeNull();
    expect((r as { reason: string }).reason).toContain('can be forced');
  });

  it('a forced region treats its three locations as equal', () => {
    expect(
      resolveHaTopology(
        [],
        'fr-par',
        ['fr-par-2', 'fr-par-1', 'fr-par-3'],
        true,
      ),
    ).toEqual({
      topology: {
        region: 'fr-par',
        zones: ['fr-par-1', 'fr-par-2', 'fr-par-3'],
        dataZones: ['fr-par-1', 'fr-par-2', 'fr-par-3'],
        validated: false,
        measured: false,
      },
    });
  });

  it('a forced region still needs servers in three locations', () => {
    const r = resolveHaTopology([], 'fr-par', ['fr-par-1', 'fr-par-2'], true);
    expect((r as { reason: string }).reason).toContain('exactly three');
  });

  it('a cluster whose nodes report no region gets no layout', () => {
    expect(resolveHaTopology([hetzner], undefined, []).topology).toBeNull();
  });
});
