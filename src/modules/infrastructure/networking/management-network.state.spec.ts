import { resolveSwitch, switchFromInstall } from './management-network.state';

describe('whether the Flui network is on', () => {
  it('is on by default', () => {
    expect(switchFromInstall({})).toEqual({ enabled: true, source: 'default' });
  });

  it('is off when the installation opted out', () => {
    expect(switchFromInstall({ FLUI_WG_ENABLED: 'false' })).toEqual({
      enabled: false,
      source: 'install',
    });
  });

  it('follows the stored setting over the installer, so a refresh cannot change it', () => {
    expect(
      resolveSwitch({ enabled: true }, { FLUI_WG_ENABLED: 'false' }),
    ).toEqual({
      enabled: true,
      source: 'setting',
    });
    expect(resolveSwitch({ enabled: false }, {})).toEqual({
      enabled: false,
      source: 'setting',
    });
  });

  it('falls back to the installer when nothing is stored', () => {
    expect(resolveSwitch(undefined, { FLUI_WG_ENABLED: 'true' }).source).toBe(
      'install',
    );
  });
});
