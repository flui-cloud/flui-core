jest.mock('@kubernetes/client-node', () => ({}));

import { fatalFromConsole } from './cluster-orchestration.service';

describe('the reason a node gave up installing, from its console', () => {
  it('reads the last FATAL line the bootstrap wrote', () => {
    const console = [
      '[   12.345678] cloud-init[1234]: [Bootstrap] waiting for ens7',
      '[  132.000001] cloud-init[1234]: [Bootstrap] FATAL: OVH private NIC ens7 never received an address',
      '[  132.100000] cloud-init[1234]: [Bootstrap] FATAL: refusing to install onto a node with no private network',
    ].join('\n');
    expect(fatalFromConsole(console)).toBe(
      'refusing to install onto a node with no private network',
    );
  });

  it('says nothing when the node never wrote one', () => {
    expect(fatalFromConsole('[  1.0] Linux version 6.8\nlogin:')).toBeNull();
  });
});
