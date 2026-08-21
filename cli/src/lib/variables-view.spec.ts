import { describeVariables } from './variables-view';
import { AppVariablesView } from './services/cli-app.service';

const view = (over: Partial<AppVariablesView> = {}): AppVariablesView => ({
  name: 'my-api',
  data: {},
  sensitiveKeys: [],
  pendingKeys: [],
  ...over,
});

/**
 * What `flui app env list` may put on a screen.
 *
 * Two things are being defended here. That a sensitive value can never be
 * printed — not "is not printed today", but cannot be, because the row carries
 * a constant instead of the datum. And that a variable still awaiting a person
 * is shown as its own state, next to the others, rather than as a gap the
 * reader has to notice.
 */
describe('describeVariables', () => {
  it('shows a plain variable with its value', () => {
    const rows = describeVariables(view({ data: { LOG_LEVEL: 'info' } }));
    expect(rows).toEqual([{ key: 'LOG_LEVEL', state: 'plain', shown: 'info' }]);
  });

  it('shows a configured secret as set, without a value', () => {
    const rows = describeVariables(
      view({ data: { TOKEN: '****' }, sensitiveKeys: ['TOKEN'] }),
    );
    expect(rows[0].state).toBe('set');
    expect(rows[0].shown).not.toContain('*');
    expect(rows[0].shown).toContain('set');
  });

  // The property, not the habit: even a value that reached this function by
  // mistake cannot be rendered, because the row never reads `data[key]`.
  it('cannot print a sensitive value even when handed one', () => {
    const rows = describeVariables(
      view({
        data: { TOKEN: 'sk_live_leaked_by_the_api' },
        sensitiveKeys: ['TOKEN'],
      }),
    );
    expect(rows[0].shown).not.toContain('sk_live');
  });

  it('lists a key still awaiting a value as its own state', () => {
    const rows = describeVariables(
      view({ pendingKeys: ['STRIPE_SECRET_KEY'] }),
    );
    expect(rows).toEqual([
      {
        key: 'STRIPE_SECRET_KEY',
        state: 'missing',
        shown: 'awaiting a value',
      },
    ]);
  });

  it('never reports one key as both configured and missing', () => {
    const rows = describeVariables(
      view({
        data: { TOKEN: '****' },
        sensitiveKeys: ['TOKEN'],
        pendingKeys: ['TOKEN'],
      }),
    );
    expect(rows).toEqual([
      { key: 'TOKEN', state: 'missing', shown: 'awaiting a value' },
    ]);
  });

  it('keeps a configured secret the read left out of the value map', () => {
    const rows = describeVariables(view({ sensitiveKeys: ['TOKEN'] }));
    expect(rows[0]).toMatchObject({ key: 'TOKEN', state: 'set' });
  });

  it('orders by name so two runs read the same', () => {
    const rows = describeVariables(
      view({
        data: { B: '2', A: '1' },
        pendingKeys: ['C'],
      }),
    );
    expect(rows.map((r) => r.key)).toEqual(['A', 'B', 'C']);
  });
});
