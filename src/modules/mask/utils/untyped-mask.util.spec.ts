import { maskUntyped } from './untyped-mask.util';

describe('maskUntyped', () => {
  const session = { sub: 'u1', iat: 1 };
  const mask = (v: unknown) => maskUntyped(v, session, 'salt');

  it('replaces emails and addresses wherever they sit', () => {
    const out = mask({
      items: [
        {
          owner: 'dawit@example.org',
          ip: '49.13.132.151',
          range: '10.10.1.0/24',
        },
        { v6: '2a01:4f8:c014:5f1b::1' },
      ],
    }) as any;
    expect(out.items[0].owner).toMatch(/@example\.com$/);
    expect(out.items[0].owner).not.toContain('dawit');
    expect(out.items[0].ip).toMatch(/^203\.0\.113\./);
    expect(out.items[0].range).toMatch(/\/24$/);
    expect(out.items[0].range).not.toBe('10.10.1.0/24');
    expect(out.items[1].v6.startsWith('2001:db8')).toBe(true);
  });

  it('replaces host-like fields by name and person-like fields by name', () => {
    const out = mask({
      fqdn: 'p1-sso.control-cluster-staging-hz.gojodigital.com',
      displayName: 'Dawit',
      name: 'umami-db',
    }) as any;
    expect(out.fqdn).not.toContain('gojodigital');
    expect(out.displayName).not.toBe('Dawit');
    expect(out.name).toBe('umami-db');
  });

  it('leaves everything else as it is, including paths and ids', () => {
    const body = {
      id: '23080e08-0000-4000-8000-000000000001',
      path: '/cluster/23080e08/overview',
      status: 'ready',
      cpuPercent: 13.7,
      at: '2026-09-27T19:00:00.000Z',
      time: '12:30:45',
      version: '1.2.3',
    };
    expect(mask(body)).toEqual(body);
  });

  it('is the same fake for the same value in one session', () => {
    const a = mask({ ip: '49.13.132.151' }) as any;
    const b = mask({ other: '49.13.132.151' }) as any;
    expect(a.ip).toBe(b.other);
  });
});
