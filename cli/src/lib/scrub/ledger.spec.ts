import { parseLedger, LedgerParseError } from './ledger';

const entry = (over: Record<string, unknown> = {}) => ({
  kind: 'server',
  providerId: '',
  name: 'flui-abc-master',
  region: 'nbg1',
  createdAt: '2026-08-18T10:00:00.000Z',
  releasedAt: null,
  ...over,
});

describe('reading the list the funnel handed the customer', () => {
  it('accepts the whole run document', () => {
    const parsed = parseLedger(
      JSON.stringify({ id: 'run_1', status: 'abandoned', ledger: [entry()] }),
    );
    expect(parsed.runId).toBe('run_1');
    expect(parsed.entries).toHaveLength(1);
  });

  it('accepts the bare array a customer copied out of it', () => {
    const parsed = parseLedger(JSON.stringify([entry()]));
    expect(parsed.runId).toBeNull();
    expect(parsed.entries[0].name).toBe('flui-abc-master');
  });

  it('accepts the outstanding list carried on a failure event', () => {
    const parsed = parseLedger(JSON.stringify({ outstanding: [entry()] }));
    expect(parsed.entries).toHaveLength(1);
  });

  /**
   * The runner writes one row before the create call and one after it. Left
   * apart they would look like two resources sharing a name, which the plan
   * refuses as ambiguous — so the fold has to happen here.
   */
  it('folds the announcement and the confirmation into one resource', () => {
    const parsed = parseLedger(
      JSON.stringify({
        ledger: [
          entry({ providerId: '', createdAt: '2026-08-18T10:00:00.000Z' }),
          entry({ providerId: '4242', createdAt: '2026-08-18T10:00:09.000Z' }),
        ],
      }),
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].providerId).toBe('4242');
    expect(parsed.entries[0].createdAt).toBe('2026-08-18T10:00:00.000Z');
  });

  it('keeps a release recorded on either row', () => {
    const parsed = parseLedger(
      JSON.stringify({
        ledger: [
          entry({ kind: 'ssh-key', name: 'k' }),
          entry({
            kind: 'ssh-key',
            name: 'k',
            releasedAt: '2026-08-18T10:05:00.000Z',
          }),
        ],
      }),
    );
    expect(parsed.entries[0].releasedAt).toBe('2026-08-18T10:05:00.000Z');
  });

  it('counts rows it cannot read instead of guessing at them', () => {
    const parsed = parseLedger(
      JSON.stringify({
        ledger: [
          entry(),
          { kind: 'load-balancer', name: 'x' },
          { name: '' },
          7,
        ],
      }),
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.ignored).toBe(3);
  });

  it('reads an empty provider id as "not known yet"', () => {
    const parsed = parseLedger(JSON.stringify([entry({ providerId: '  ' })]));
    expect(parsed.entries[0].providerId).toBeNull();
  });

  it.each([
    ['', 'empty input'],
    ['not json at all', 'unparsable input'],
    ['{"status":"abandoned"}', 'a document with no list in it'],
  ])('refuses %s rather than proceeding on nothing', (raw) => {
    expect(() => parseLedger(raw)).toThrow(LedgerParseError);
  });
});
