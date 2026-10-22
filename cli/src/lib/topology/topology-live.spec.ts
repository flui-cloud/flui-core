jest.mock('chalk', () => {
  const same = (text: string) => text;
  const chalk: any = new Proxy(same, { get: () => chalk });
  return { __esModule: true, default: chalk };
});

import { PassThrough } from 'node:stream';
import {
  exampleTopology,
  exampleTopologyChanges,
} from '../../../../src/modules/sandbox/stand-in/sandbox-world-topology';
import {
  applyTopologyEvent,
  describeEvent,
  liveTopology,
  parseFrame,
} from './topology-live';

const QUIET = 1792663560000;
const BUSY = QUIET + 180_000;

describe('topology stream', () => {
  it('reads a frame the way Nest writes it, and the wrapped form', () => {
    expect(
      parseFrame('event: app.scaled\nid: 4\ndata: {"appId":"a1"}'),
    ).toEqual({
      event: 'app.scaled',
      data: { appId: 'a1' },
    });
    expect(parseFrame('data: {"type":"heartbeat","data":{"ts":"x"}}')).toEqual({
      event: 'heartbeat',
      data: { ts: 'x' },
    });
    expect(parseFrame(': comment')).toBeNull();
    expect(parseFrame('data: not json')).toBeNull();
  });

  it('lands where a fresh snapshot would when the storefront scales', () => {
    const before = exampleTopology(QUIET);
    const after = exampleTopology(BUSY);
    const scaled = exampleTopologyChanges(QUIET, BUSY).find(
      (c) => c.event === 'app.scaled',
    )!;
    const message = { event: scaled.event, data: scaled.data };
    const patched = applyTopologyEvent(before, message);
    const storefront = (t: typeof before) =>
      t.apps.find((a) => a.id === 'example-app-1')!;
    expect(storefront(patched).replicas).toEqual(storefront(after).replicas);
    expect(describeEvent(before, message)).toBe(
      'Storefront scaled up: 2 → 3 replicas',
    );
  });

  it('returns the same snapshot for a change about something it does not hold', () => {
    const t = exampleTopology(QUIET);
    expect(
      applyTopologyEvent(t, {
        event: 'app.scaled',
        data: { appId: 'nope', replicaCount: 9 },
      }),
    ).toBe(t);
    expect(applyTopologyEvent(t, { event: 'heartbeat', data: {} })).toBe(t);
  });

  it('removes an app and keeps its stack only while it has members', () => {
    const t = exampleTopology(QUIET);
    const docs = applyTopologyEvent(t, {
      event: 'app.removed',
      data: { appId: 'example-app-1-docs' },
    });
    expect(docs.apps.some((a) => a.id === 'example-app-1-docs')).toBe(false);
    expect(docs.stacks.some((s) => s.id === 'app:example-app-1-docs')).toBe(
      false,
    );
    const worker = applyTopologyEvent(t, {
      event: 'app.removed',
      data: { appId: 'example-app-4' },
    });
    expect(
      worker.stacks.find((s) => s.id === 'example-stack-shop'),
    ).toMatchObject({
      appIds: ['example-app-1', 'example-app-2'],
      status: 'running',
    });
  });

  it('patches the snapshot from the stream and stops cleanly', async () => {
    const body = new PassThrough();
    const api = {
      getStream: jest.fn().mockResolvedValue(body),
      get: jest.fn(),
    };
    const seen: Array<string | null> = [];
    const connection: boolean[] = [];
    const live = liveTopology(api as never, true, exampleTopology(QUIET), {
      onSnapshot: (_t, change) => seen.push(change),
      onConnection: (up) => connection.push(up),
    });
    await new Promise((r) => setImmediate(r));
    expect(api.getStream).toHaveBeenCalledWith('/topology/stream?system=1');
    const scaled = exampleTopologyChanges(QUIET, BUSY).find(
      (c) => c.event === 'app.scaled',
    )!;
    body.write(`event: heartbeat\ndata: {"ts":"x"}\n\n`);
    body.write(`event: app.scaled\ndata: ${JSON.stringify(scaled.data)}\n\n`);
    await new Promise((r) => setImmediate(r));
    expect(connection).toEqual([true]);
    expect(seen).toEqual(['Storefront scaled up: 2 → 3 replicas']);
    live.stop();
    expect(body.destroyed).toBe(true);
  });
});
