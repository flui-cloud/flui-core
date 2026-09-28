import { SHAPES_DEADLINE_MS, ShapeFactsService } from './shape-facts.service';

function withProvider(getNodeSizes: jest.Mock) {
  return new ShapeFactsService({
    getProvider: () => ({ getNodeSizes }),
  } as never);
}

const size = (available: boolean) => ({
  id: '115',
  name: 'cx33',
  cores: 4,
  memory: 8,
  deprecated: false,
  supportsHourlyBilling: true,
  prices: [],
  availability: [{ location: 'fsn1', available }],
});

describe('the shapes the engine chooses from', () => {
  it('asks the provider whether each can be bought, not only what it costs', async () => {
    const getNodeSizes = jest.fn().mockResolvedValue([size(false)]);

    const reading = await withProvider(getNodeSizes).read('hetzner');

    expect(getNodeSizes).toHaveBeenCalledWith(true);
    expect(reading.shapes[0].availability).toEqual([
      { region: 'fsn1', up: false },
    ]);
  });

  it('asks again after a few minutes, since stock does not stay put for an hour', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-24T20:00:00Z'));
    const getNodeSizes = jest
      .fn()
      .mockResolvedValueOnce([size(false)])
      .mockResolvedValueOnce([size(true)]);
    const facts = withProvider(getNodeSizes);

    await facts.read('hetzner');
    jest.setSystemTime(new Date('2026-09-24T20:06:00Z'));
    const later = await facts.read('hetzner');

    expect(getNodeSizes).toHaveBeenCalledTimes(2);
    expect(later.shapes[0].availability?.[0].up).toBe(true);
    jest.useRealTimers();
  });
});

describe('a provider slow to list its sizes', () => {
  afterEach(() => jest.useRealTimers());

  it('is reported as unread once the deadline passes, and the late answer serves the next caller', async () => {
    jest.useFakeTimers();
    let answer!: (sizes: unknown[]) => void;
    const getNodeSizes = jest.fn().mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const facts = withProvider(getNodeSizes);

    const first = facts.read('ovh');
    await jest.advanceTimersByTimeAsync(SHAPES_DEADLINE_MS);
    expect(await first).toEqual({ shapes: [], read: false });

    answer([size(true)]);
    await Promise.resolve();
    const next = await facts.read('ovh');

    expect(getNodeSizes).toHaveBeenCalledTimes(1);
    expect(next.read).toBe(true);
    expect(next.shapes[0].shape).toBe('cx33');
  });

  it('joins a read already running instead of asking the provider twice', async () => {
    jest.useFakeTimers();
    const getNodeSizes = jest
      .fn()
      .mockReturnValue(new Promise(() => undefined));
    const facts = withProvider(getNodeSizes);

    const reads = [facts.read('ovh'), facts.read('ovh')];
    await jest.advanceTimersByTimeAsync(SHAPES_DEADLINE_MS);
    await Promise.all(reads);

    expect(getNodeSizes).toHaveBeenCalledTimes(1);
  });
});
