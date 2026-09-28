import { nextSshSources, sshSourcesOf, withSshSource } from './ssh-allowlist';

describe('SSH allowlist', () => {
  it('keeps an address that is only on the provider when adding another', () => {
    const { next } = nextSshSources(
      ['79.22.54.60/32'],
      ['93.40.1.2/32'],
      ['5.6.7.8/32'],
      'add',
    );
    expect(next).toEqual(['79.22.54.60/32', '93.40.1.2/32', '5.6.7.8/32']);
  });

  it('removes from both sides', () => {
    const { next } = nextSshSources(
      ['1.1.1.1/32', '2.2.2.2/32'],
      ['2.2.2.2/32'],
      ['2.2.2.2/32'],
      'remove',
    );
    expect(next).toEqual(['1.1.1.1/32']);
  });

  it('replaces with exactly what was asked', () => {
    const { next } = nextSshSources(
      ['1.1.1.1/32'],
      ['2.2.2.2/32'],
      ['3.3.3.3/32'],
      'replace',
    );
    expect(next).toEqual(['3.3.3.3/32']);
  });

  it('changes only the SSH rule of the saved rules, keeping peer rules', () => {
    const saved = [
      {
        description: 'ssh',
        direction: 'in' as const,
        protocol: 'tcp' as const,
        port: '22',
        sourceIps: ['1.1.1.1/32'],
      },
      {
        id: 'flui:xprovider:wg-listen',
        description: 'tunnel',
        direction: 'in' as const,
        protocol: 'udp' as const,
        port: '51821',
        sourceIps: ['9.9.9.9/32'],
      },
    ];
    const out = withSshSource(saved, ['1.1.1.1/32', '5.6.7.8/32']);
    expect(sshSourcesOf(out)).toEqual(['1.1.1.1/32', '5.6.7.8/32']);
    expect(out[1]).toEqual(saved[1]);
  });
});
