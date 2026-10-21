import { QueueIntakeService, isQueue } from './queue-intake.service';

function queue(name: string, pause: jest.Mock) {
  return { name, pause, getJobCounts: jest.fn() };
}

function service(instances: unknown[]) {
  return new QueueIntakeService({
    getProviders: () => instances.map((instance) => ({ instance })),
  } as never);
}

describe('a copy of the API on its way out', () => {
  afterEach(() => jest.useRealTimers());

  it('stops taking new jobs on every queue, without waiting for running ones', async () => {
    const deploy = jest.fn().mockResolvedValue(undefined);
    const infra = jest.fn().mockResolvedValue(undefined);

    await service([
      queue('application-deploy', deploy),
      queue('infrastructure', infra),
      { name: 'not-a-queue' },
      null,
    ]).onModuleDestroy();

    expect(deploy).toHaveBeenCalledWith(true, true);
    expect(infra).toHaveBeenCalledWith(true, true);
  });

  it('does not hold up shutdown on a queue whose Redis does not answer', async () => {
    jest.useFakeTimers();
    const stuck = jest.fn(() => new Promise<void>(() => undefined));
    const done = service([queue('backup', stuck)]).onModuleDestroy();

    await jest.advanceTimersByTimeAsync(5_000);

    await expect(done).resolves.toBeUndefined();
  });

  it('recognises a queue by what it can do, not by its name', () => {
    expect(isQueue(queue('app-build', jest.fn()))).toBe(true);
    expect(isQueue({ pause: jest.fn(), name: 'x' })).toBe(false);
  });
});
