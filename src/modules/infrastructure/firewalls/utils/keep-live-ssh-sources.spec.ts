import { keepLiveSshSources } from './keep-live-ssh-sources';

const ssh = (
  sourceIps: string[],
  description = 'SSH access for server management',
) => ({
  description,
  direction: 'in' as const,
  protocol: 'tcp' as const,
  port: '22',
  sourceIps,
});
const tunnel = {
  description: 'flui:xprovider:wg-listen',
  direction: 'in' as const,
  protocol: 'udp' as const,
  port: '51821',
  sourceIps: ['9.9.9.9/32'],
};

describe('keepLiveSshSources', () => {
  it('keeps an SSH source someone added on the provider when Flui adds a rule of its own', () => {
    const { rules, kept } = keepLiveSshSources(
      [ssh(['79.22.54.60/32']), tunnel],
      [ssh(['79.22.54.60/32', '93.40.1.2/32'])],
    );
    expect(kept).toEqual(['93.40.1.2/32']);
    expect(rules[0].sourceIps).toEqual(['79.22.54.60/32', '93.40.1.2/32']);
    expect(rules[1]).toEqual(tunnel);
  });

  it('changes nothing when the provider has nothing extra', () => {
    const desired = [ssh(['1.1.1.1/32'])];
    expect(keepLiveSshSources(desired, [ssh(['1.1.1.1/32'])])).toEqual({
      rules: desired,
      kept: [],
    });
  });

  it('never reopens a port 22 Flui closed on purpose (SSH through the control)', () => {
    const desired = [ssh(['5.6.7.8/32'], 'flui:xprovider:ssh-via-control')];
    expect(keepLiveSshSources(desired, [ssh(['0.0.0.0/0'])]).kept).toEqual([]);
  });
});
