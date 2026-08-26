import { BuiltinProbes } from './builtin-probes';
import { ContextProbe, ContextProbeRegistry } from './context-probe';
import { probeCards } from './probe-catalog';

function shipped(): ContextProbe[] {
  const registry = new ContextProbeRegistry();
  const apps = {
    findOne: jest.fn(async () => null),
    count: jest.fn(async () => 0),
  };
  const clusters = { findOne: jest.fn(async () => null) };
  new BuiltinProbes(registry, apps as never, clusters as never).onModuleInit();
  return registry.list();
}

/** Every declared parameter filled with something the declaration accepts. */
function filled(probe: ContextProbe): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const p of probe.takes ?? []) params[p.name] = p.oneOf?.[0] ?? 'x';
  return params;
}

/**
 * The seam between what the catalogue promises and what the write enforces.
 *
 * These run over whatever the registry holds rather than over a list written
 * here, so a probe added tomorrow is held to the same bargain without this file
 * being opened. That is the whole point: a hand-kept second statement of what
 * each probe wants would drift the first time somebody changed a probe, and a
 * contract that drifts silently is worse than the silence it replaced.
 */
describe('the probes the platform ships', () => {
  it('all declare what they take', () => {
    for (const probe of shipped()) {
      expect(probe.takes).toBeDefined();
    }
  });

  it('will not run without a parameter they published as required', async () => {
    for (const probe of shipped()) {
      for (const param of probe.takes ?? []) {
        if (!param.required) continue;
        const params = filled(probe);
        delete params[param.name];
        await expect(probe.run(params)).rejects.toThrow(
          `${param.name} is missing`,
        );
      }
    }
  });

  it('run once every parameter they published is supplied', async () => {
    for (const probe of shipped()) {
      await expect(probe.run(filled(probe))).resolves.toBeDefined();
    }
  });

  it('refuse a value outside the set they published', async () => {
    for (const probe of shipped()) {
      const set = (probe.takes ?? []).find((p) => p.oneOf?.length);
      if (!set) continue;
      await expect(
        probe.run({ ...filled(probe), [set.name]: 'certainly-not' }),
      ).rejects.toThrow(/is not a .* a note may lean on/);
    }
  });
});

describe('the catalogue the shipped probes produce', () => {
  it('tells an author that an application field is named by slug', () => {
    const card = probeCards(shipped()).find((c) => c.id === 'app.field');
    expect(card?.takes).toEqual([
      { name: 'slug', required: true },
      { name: 'field', required: true, oneOf: expect.any(Array) },
    ]);
  });

  /**
   * The field a note leans on decides how its premise is read: `replicas
   * equals "2"` is stored as the number 2 and compared strictly ever after,
   * and `status atLeast …` can never hold. Both are refusals at write time, so
   * both have to be knowable before the save.
   */
  it('says which fields answer a number and which a string, without being told twice', () => {
    const card = probeCards(shipped()).find((c) => c.id === 'app.field');
    expect(card?.answersPer?.param).toBe('field');
    expect(card?.answersPer?.types.replicas).toBe('number');
    expect(card?.answersPer?.types.status).toBe('string');
  });

  it('publishes exactly the fields the probe will answer over, and no others', () => {
    for (const card of probeCards(shipped())) {
      const set = (card.takes ?? []).find((p) => p.oneOf?.length);
      if (!set || !card.answersPer) continue;
      expect(Object.keys(card.answersPer.types).sort()).toEqual(
        [...(set.oneOf ?? [])].sort(),
      );
    }
  });

  it('answers a count with a number whatever it is asked', () => {
    const card = probeCards(shipped()).find((c) => c.id === 'cluster.appCount');
    expect(card?.answers).toBe('number');
  });

  /**
   * The write path never calls `run`, so a rule that lives only in `run` is not
   * a rule at all.
   *
   * `cluster.field` takes either an id or a name, and the parameter vocabulary
   * cannot say "one of these two". A note that named neither used to be
   * accepted with its premise stored, and then answered `unknown` for ever:
   * advice delivered as unverified prose, for a reason that was never true —
   * the same silent lie the strict comparison was fixed for. Asked here through
   * `answers`, which is what the write actually calls.
   */
  it('refuses a premise it could never be asked, at write time and not only at run time', () => {
    const probe = shipped().find((x) => x.id === 'cluster.field')!;
    expect(() => probe.answers?.({ field: 'status' })).toThrow(
      /clusterId or clusterName/,
    );
    expect(probe.answers?.({ field: 'status', clusterId: 'c1' })).toBe(
      'string',
    );
    expect(probe.answers?.({ field: 'status', clusterName: 'prod' })).toBe(
      'string',
    );
  });

  it('carries no value read out of the installation', () => {
    for (const card of probeCards(shipped())) {
      expect(Object.keys(card).every((k) => KNOWN.has(k))).toBe(true);
    }
  });
});

const KNOWN = new Set(['id', 'describes', 'takes', 'answers', 'answersPer']);
