import { overlayRulesetOptions } from './overlay-ruleset-policy';

describe('what the overlay interface is trusted with', () => {
  afterEach(() => delete process.env.FLUI_OBS_INGEST_NODEPORTS);

  it('names the API server and both telemetry ingests', () => {
    const ports = overlayRulesetOptions().wgOnlyPorts?.map((p) => p.port);
    expect(ports).toEqual([6443, 30100, 30428]);
  });

  it('follows the configured ingest ports', () => {
    process.env.FLUI_OBS_INGEST_NODEPORTS = '31000';
    expect(overlayRulesetOptions().wgOnlyPorts?.map((p) => p.port)).toEqual([
      6443, 31000,
    ]);
  });
});
