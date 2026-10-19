import {
  GuestInferenceSettingsService,
  LIVE_CONFIG_TTL_MS,
} from './guest-inference-settings.service';
import { controlApiConfigReader } from './api-config-reader';

describe('GuestInferenceSettingsService', () => {
  const build = (opts: {
    env?: Record<string, string>;
    live?: Record<string, string> | Error;
    control?: boolean;
  }) => {
    let live = opts.live ?? {};
    const getClusterConfig = jest.fn(async () => {
      if (live instanceof Error) throw live;
      return { data: live };
    });
    const service = new GuestInferenceSettingsService(
      { get: (key: string) => opts.env?.[key] } as never,
      controlApiConfigReader(
        {
          findOne: async () => (opts.control === false ? null : { id: 'c1' }),
        } as never,
        { getClusterConfig } as never,
      ),
    );
    return {
      service,
      getClusterConfig,
      setLive: (next: Record<string, string> | Error) => (live = next),
    };
  };

  it('reads the API configuration on the control cluster', async () => {
    const t = build({ live: { SANDBOX_INFERENCE_ENABLED: 'false' } });

    expect((await t.service.limits(0)).enabled).toBe(false);
    expect(t.getClusterConfig).toHaveBeenCalledWith(
      'c1',
      'flui-api-config',
      'flui-system',
    );
  });

  it('falls back to the process environment for a key missing there', async () => {
    const t = build({
      env: { SANDBOX_INFERENCE_PER_MINUTE: '3' },
      live: { SANDBOX_INFERENCE_PER_HOUR: '20' },
    });

    expect(await t.service.limits(0)).toMatchObject({
      perMinute: 3,
      perHour: 20,
    });
  });

  it('picks a change up after the cache expires, without a restart', async () => {
    const t = build({ live: {} });

    expect((await t.service.limits(0)).enabled).toBe(true);
    t.setLive({ SANDBOX_INFERENCE_ENABLED: 'false' });
    expect((await t.service.limits(LIVE_CONFIG_TTL_MS - 1)).enabled).toBe(true);
    expect((await t.service.limits(LIVE_CONFIG_TTL_MS)).enabled).toBe(false);
    expect(t.getClusterConfig).toHaveBeenCalledTimes(2);
  });

  it('keeps the last known values when the cluster does not answer', async () => {
    const t = build({ live: { SANDBOX_INFERENCE_ENABLED: 'false' } });

    await t.service.limits(0);
    t.setLive(new Error('unreachable'));

    expect((await t.service.limits(LIVE_CONFIG_TTL_MS)).enabled).toBe(false);
  });

  it('uses only the environment where there is no control cluster', async () => {
    const t = build({
      control: false,
      env: { SANDBOX_INFERENCE_DAILY_TOKENS: '1000' },
    });

    expect((await t.service.limits(0)).instanceDailyTokens).toBe(1000);
    expect(t.getClusterConfig).not.toHaveBeenCalled();
  });
});
