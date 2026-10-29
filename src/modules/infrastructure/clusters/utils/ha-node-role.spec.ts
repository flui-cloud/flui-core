import { haRoleMetadata, haRoleOf, k3sRoleOf } from './ha-node-role';

describe('ha-node-role', () => {
  it('reads only the roles Flui records', () => {
    expect(haRoleOf({ metadata: { haRole: 'server' } })).toBe('server');
    expect(haRoleOf({ metadata: { haRole: 'data-host' } })).toBe('data-host');
    expect(haRoleOf({ metadata: { haRole: 'master' } })).toBeNull();
    expect(haRoleOf({ metadata: null })).toBeNull();
  });

  it('joins only a server to the control plane', () => {
    expect(k3sRoleOf('server')).toBe('server');
    expect(k3sRoleOf('data-host')).toBe('agent');
    expect(k3sRoleOf(null)).toBe('agent');
  });

  it('records the role, and nothing for an ordinary worker', () => {
    expect(haRoleMetadata('data-host')).toEqual({ haRole: 'data-host' });
    expect(haRoleMetadata(null)).toEqual({});
  });
});
