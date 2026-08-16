import { TerminalFeatureConfig } from './terminal-feature.config';

describe('TerminalFeatureConfig', () => {
  const original = process.env.FLUI_WEB_TERMINAL_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.FLUI_WEB_TERMINAL_ENABLED;
    else process.env.FLUI_WEB_TERMINAL_ENABLED = original;
  });

  it('is off when nothing is set, so a default install keeps no CA in the cluster', () => {
    delete process.env.FLUI_WEB_TERMINAL_ENABLED;
    expect(new TerminalFeatureConfig().enabled).toBe(false);
  });

  it('only accepts an explicit "true" — no truthy strings, no accidents', () => {
    for (const value of ['1', 'yes', 'on', 'TRUE', '']) {
      process.env.FLUI_WEB_TERMINAL_ENABLED = value;
      expect(new TerminalFeatureConfig().enabled).toBe(false);
    }
    process.env.FLUI_WEB_TERMINAL_ENABLED = 'true';
    expect(new TerminalFeatureConfig().enabled).toBe(true);
  });
});
