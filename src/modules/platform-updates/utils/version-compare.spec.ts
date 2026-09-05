import { compareVersions, isNewerThan } from './version-compare';

describe('compareVersions', () => {
  it('orders by numeric parts', () => {
    expect(compareVersions('0.14.0', '0.13.0')).toBe(1);
    expect(compareVersions('0.13.0', '0.14.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.13.1', '0.13.0')).toBe(1);
  });

  it('ranks a release above its own prerelease', () => {
    expect(compareVersions('0.13.0', '0.13.0-rc.1')).toBe(1);
    expect(compareVersions('0.13.0-rc.1', '0.13.0')).toBe(-1);
  });

  it('orders prereleases among themselves', () => {
    expect(compareVersions('0.13.0-rc.2', '0.13.0-rc.1')).toBe(1);
    expect(compareVersions('0.13.0-rc.10', '0.13.0-rc.2')).toBe(1);
    expect(compareVersions('0.13.0-beta.1', '0.13.0-alpha.9')).toBe(1);
  });

  it('treats equal versions as equal, with or without a v prefix', () => {
    expect(compareVersions('0.13.0', '0.13.0')).toBe(0);
    expect(compareVersions('v0.13.0', '0.13.0')).toBe(0);
    expect(compareVersions('0.6', '0.6.0')).toBe(0);
  });

  it('refuses to compare non-versions', () => {
    expect(compareVersions('latest', '0.13.0')).toBeNull();
    expect(compareVersions('0.13.0', 'master')).toBeNull();
    expect(compareVersions('sha-a1b2c3d', '0.13.0')).toBeNull();
  });

  it('never calls an uncomparable pair an upgrade', () => {
    expect(isNewerThan('latest', '0.13.0')).toBe(false);
    expect(isNewerThan('0.14.0', '0.13.0-rc.1')).toBe(true);
    expect(isNewerThan('0.13.0-rc.1', '0.13.0-rc.1')).toBe(false);
  });
});
