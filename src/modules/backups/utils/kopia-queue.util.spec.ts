import { KopiaJobQueue, kopiaStartJitterMs } from './kopia-queue.util';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('the kopia Job queue', () => {
  it('never runs two tasks on one repository at once', async () => {
    const queue = new KopiaJobQueue(4);
    const order: string[] = [];
    const first = deferred();
    const a = queue.run('repo', async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = queue.run('repo', async () => {
      order.push('b:start');
    });
    await tick();
    expect(order).toEqual(['a:start']);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('caps how many run across repositories', async () => {
    const queue = new KopiaJobQueue(2);
    const gates = [deferred(), deferred(), deferred()];
    const runs = gates.map((g, i) => queue.run(`r${i}`, () => g.promise));
    await tick();
    expect(queue.active).toBe(2);
    gates[0].resolve();
    await tick();
    await tick();
    expect(queue.active).toBe(2);
    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(runs);
    expect(queue.active).toBe(0);
  });

  it('lets the next task run after one fails', async () => {
    const queue = new KopiaJobQueue(1);
    await expect(
      queue.run('repo', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(queue.run('repo', async () => 'ok')).resolves.toBe('ok');
  });

  it('spreads starts across half a minute', () => {
    expect(kopiaStartJitterMs(() => 0)).toBe(0);
    expect(kopiaStartJitterMs(() => 0.5)).toBe(15_000);
    expect(kopiaStartJitterMs(() => 0.999)).toBeLessThan(30_000);
  });
});
