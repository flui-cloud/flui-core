import { normalizeOvhServerStatus } from './ovh-provider.service';

describe('normalizeOvhServerStatus', () => {
  it('maps Nova ACTIVE to the common "running" ServersService.waitForServerReady polls for', () => {
    expect(normalizeOvhServerStatus('ACTIVE')).toBe('running');
  });

  it('maps Nova ERROR to the common "error"', () => {
    expect(normalizeOvhServerStatus('ERROR')).toBe('error');
  });

  it('lowercases any other Nova status rather than leaving it opaque uppercase', () => {
    expect(normalizeOvhServerStatus('BUILD')).toBe('build');
    expect(normalizeOvhServerStatus('SHUTOFF')).toBe('shutoff');
  });
});
