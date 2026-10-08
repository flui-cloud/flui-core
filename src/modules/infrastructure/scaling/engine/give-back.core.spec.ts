import { DrainCheck } from './drain.core';
import { giveBackReasons, giveBackSentence } from './give-back.core';

const check = (blockers: DrainCheck['blockers']): DrainCheck => ({
  ok: false,
  node: 'worker-1',
  cleared: [],
  blockers,
});

describe('why a node above the target cannot go back', () => {
  it('names each application once under the cause it shares with others', () => {
    const pg = { id: 'a1', slug: 'postgresql-04f3a9' };
    const reasons = giveBackReasons(
      check([
        { kind: 'dedicated-app', what: pg.slug, fix: 'x', application: pg },
        {
          kind: 'bound-volume',
          what: 'ns/postgresql-04f3a9-0 → data-postgresql-04f3a9-0',
          fix: 'x',
          application: pg,
        },
        {
          kind: 'bound-volume',
          what: 'ns/linkding-7c9 → data',
          fix: 'x',
          application: { id: 'a2', slug: 'linkding' },
        },
      ]),
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0].kind).toBe('data-on-node');
    expect(reasons[0].items).toEqual([
      { label: 'postgresql-04f3a9', applicationId: 'a1' },
      { label: 'linkding', applicationId: 'a2' },
    ]);
  });

  // Checks recorded before blockers carried an application still read as names,
  // not as a namespace, a pod and a volume joined by an arrow.
  it('reads a blocker with no application by the workload it is about', () => {
    const reasons = giveBackReasons(
      check([
        { kind: 'no-controller', what: 'user-x/echo-29840964-4pw54', fix: 'x' },
        { kind: 'bound-volume', what: 'user-x/pg-0 → data-pg-0', fix: 'x' },
      ]),
    );

    expect(reasons.map((r) => r.items[0].label)).toEqual([
      'pg-0',
      'echo-29840964-4pw54',
    ]);
  });

  it('puts it in one sentence a row can carry', () => {
    const reasons = giveBackReasons(
      check([
        {
          kind: 'dedicated-app',
          what: 'a',
          fix: 'x',
          application: { id: '1', slug: 'a' },
        },
        {
          kind: 'dedicated-app',
          what: 'b',
          fix: 'x',
          application: { id: '2', slug: 'b' },
        },
        { kind: 'no-controller', what: 'ns/stray', fix: 'x' },
      ]),
    );

    expect(giveBackSentence(reasons)).toBe(
      '2 applications keep their data on it; 1 workload would not be started again elsewhere',
    );
  });
});
