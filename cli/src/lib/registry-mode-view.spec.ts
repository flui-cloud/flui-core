import {
  RegistryModeStatus,
  defaultStorage,
  registryModeLines,
  waitForRegistry,
} from './registry-mode-view';

const status = (
  over: Partial<RegistryModeStatus> = {},
): RegistryModeStatus => ({
  mode: 'flui',
  source: 'setting',
  storage: 'volume',
  host: 'api.example.test',
  ready: true,
  detail: null,
  bucketConnected: false,
  applicationsOnRegistry: 2,
  ...over,
});

describe('registryModeLines', () => {
  it('points an installation on GHCR at the command that switches it', () => {
    const lines = registryModeLines(
      status({ mode: 'ghcr', storage: null, ready: null }),
    );
    expect(lines[0]).toContain('GitHub Container Registry');
    expect(lines.join('\n')).toContain('flui registry enable');
  });

  it('shows where the Flui registry answers, keeps images, and whether it is up', () => {
    const lines = registryModeLines(
      status({ storage: 's3', ready: false, source: 'install' }),
    );
    expect(lines.join('\n')).toContain('api.example.test');
    expect(lines.join('\n')).toContain('the connected bucket');
    expect(lines.join('\n')).toContain('starting');
    expect(lines.join('\n')).toContain('Chosen at install');
  });
});

describe('defaultStorage', () => {
  it('uses the bucket when one is connected, else the volume', () => {
    expect(defaultStorage({ bucketConnected: true })).toBe('s3');
    expect(defaultStorage({ bucketConnected: false })).toBe('volume');
  });
});

describe('waitForRegistry', () => {
  it('polls until the registry is ready', async () => {
    const answers = [
      status({ ready: false }),
      status({ ready: false }),
      status({ ready: true }),
    ];
    const slept: number[] = [];
    const result = await waitForRegistry(async () => answers.shift()!, {
      timeoutMs: 60_000,
      intervalMs: 5,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(result.ready).toBe(true);
    expect(slept).toEqual([5, 5]);
  });

  it('gives up at the deadline and returns what it last read', async () => {
    let clock = 0;
    const result = await waitForRegistry(async () => status({ ready: false }), {
      timeoutMs: 10,
      intervalMs: 4,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(result.ready).toBe(false);
    expect(clock).toBeGreaterThanOrEqual(10);
  });

  it('does not wait on an installation on GHCR', async () => {
    let reads = 0;
    await waitForRegistry(
      async () => {
        reads += 1;
        return status({ mode: 'ghcr', ready: null });
      },
      { timeoutMs: 1000, intervalMs: 1, sleep: async () => undefined },
    );
    expect(reads).toBe(1);
  });
});
