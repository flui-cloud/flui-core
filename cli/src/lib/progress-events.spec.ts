import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('progress events', () => {
  const originalFd = process.env.FLUI_EVENTS_FD;

  afterEach(() => {
    if (originalFd === undefined) delete process.env.FLUI_EVENTS_FD;
    else process.env.FLUI_EVENTS_FD = originalFd;
    jest.resetModules();
  });

  it('stays silent when no descriptor is configured', () => {
    delete process.env.FLUI_EVENTS_FD;
    jest.resetModules();

    const events = require('./progress-events');
    expect(events.eventsEnabled()).toBe(false);
    expect(() =>
      events.emitEvent({ type: 'phase', phase: 'init', state: 'started' }),
    ).not.toThrow();
  });

  it('refuses stdout and stderr, so decorated output is never polluted', () => {
    for (const fd of ['1', '2']) {
      process.env.FLUI_EVENTS_FD = fd;
      jest.resetModules();
      expect(require('./progress-events').eventsEnabled()).toBe(false);
    }
  });

  it('writes one JSON object per line to the configured descriptor', () => {
    const file = join(
      mkdtempSync(join(tmpdir(), 'flui-events-')),
      'events.ndjson',
    );
    const fd = openSync(file, 'a');
    process.env.FLUI_EVENTS_FD = String(fd);
    jest.resetModules();

    const { emitEvent, eventsEnabled } = require('./progress-events');
    expect(eventsEnabled()).toBe(true);

    emitEvent({
      type: 'phase',
      phase: 'server-create',
      state: 'started',
      percent: 12,
    });
    emitEvent({ type: 'ready', endpoint: 'https://example.flui.host' });
    closeSync(fd);

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({
      type: 'phase',
      phase: 'server-create',
      state: 'started',
    });
    expect(typeof first.at).toBe('string');
    expect(JSON.parse(lines[1]).endpoint).toBe('https://example.flui.host');
  });
});
