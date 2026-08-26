import { ContextProbeRegistry, ProbeExpectationProblem } from './context-probe';
import { BuiltinProbes, APP_READABLE_FIELDS } from './builtin-probes';

const registryWith = (answer: () => Promise<unknown>) => {
  const r = new ContextProbeRegistry();
  r.register({ id: 'p', describes: 'a probe', run: answer });
  return r;
};

describe('a premise re-asked against live state', () => {
  it('holds when the platform agrees', async () => {
    const r = registryWith(async () => 'master-1');
    await expect(
      r.evaluate('p', {}, 'equals', 'master-1'),
    ).resolves.toMatchObject({ status: 'holds' });
  });

  it('breaks when the platform disagrees', async () => {
    const r = registryWith(async () => 'worker-3');
    await expect(
      r.evaluate('p', {}, 'equals', 'master-1'),
    ).resolves.toMatchObject({ status: 'broken' });
  });

  it('compares numbers both ways round', async () => {
    const r = registryWith(async () => 3);
    await expect(r.evaluate('p', {}, 'atLeast', 3)).resolves.toMatchObject({
      status: 'holds',
    });
    await expect(r.evaluate('p', {}, 'atMost', 2)).resolves.toMatchObject({
      status: 'broken',
    });
  });

  /**
   * The three ways a comparison can be *unavailable*, and none of them may
   * produce `broken`. A rule that disappeared because a repository was down, or
   * because somebody renamed a probe, would be worse than no mechanism at all —
   * it would teach people the flag means nothing.
   */
  it('answers unknown when the probe does not exist', async () => {
    const r = new ContextProbeRegistry();
    await expect(r.evaluate('gone', {}, 'equals', 1)).resolves.toMatchObject({
      status: 'unknown',
    });
  });

  it('answers unknown when the probe throws', async () => {
    const r = registryWith(async () => {
      throw new Error('database is away');
    });
    await expect(r.evaluate('p', {}, 'equals', 1)).resolves.toMatchObject({
      status: 'unknown',
    });
  });

  it('answers unknown when the two values cannot be compared', async () => {
    const r = registryWith(async () => 'three');
    await expect(r.evaluate('p', {}, 'atLeast', 3)).resolves.toMatchObject({
      status: 'unknown',
    });
  });

  it('never leaks the value it found into the detail it reports', async () => {
    const r = registryWith(async () => 'a-very-specific-secret-looking-value');
    const out = await r.evaluate('p', {}, 'equals', 'other');
    expect(out.detail).not.toContain('a-very-specific-secret-looking-value');
  });
});

/**
 * The two halves of the registry, and they are deliberately opposite in temper.
 *
 * Evaluation never throws, because a note must not withdraw itself over a
 * repository that was briefly away. Writing refuses loudly, because a premise
 * nobody can ever check is a defect the author can still fix while they are
 * looking at the form.
 */
describe('a premise being written down', () => {
  const registry = () => {
    const r = new ContextProbeRegistry();
    r.register({
      id: 'p',
      describes: 'a probe',
      answers: (params) => (params.field === 'count' ? 'number' : 'string'),
      run: async () => 3,
    });
    return r;
  };

  it('stores what a form posted in the type the probe answers', () => {
    expect(registry().interpret('p', { field: 'count' }, 'equals', '3')).toBe(
      3,
    );
  });

  it('refuses a premise that could never be read in that type', () => {
    expect(() =>
      registry().interpret('p', { field: 'count' }, 'equals', 'three'),
    ).toThrow(ProbeExpectationProblem);
  });

  /**
   * A note leaning on a fact nobody offers is `unknown` for ever: it looks
   * checked in the writing and is prose in the reading. Refused at the one
   * moment somebody can still choose a different probe.
   */
  it('refuses a note that leans on a fact nobody offers', () => {
    expect(() => registry().interpret('gone', {}, 'equals', 'x')).toThrow(
      /Nothing here offers a fact called/,
    );
  });

  it('refuses parameters the probe says it will not answer, and says why', () => {
    const r = new ContextProbeRegistry();
    r.register({
      id: 'p',
      describes: 'a probe',
      answers: () => {
        throw new Error('“env” is not a field a note may lean on');
      },
      run: async () => null,
    });
    expect(() => r.interpret('p', { field: 'env' }, 'equals', 'x')).toThrow(
      /is not a field a note may lean on/,
    );
  });

  /**
   * The falsification of the whole mechanism, end to end: the premise that used
   * to make a note accuse itself now holds, and the strict comparison is
   * untouched — it is the *stored value* that changed.
   */
  it('makes the premise that used to declare itself broken hold', async () => {
    const r = registry();
    const stored = r.interpret('p', { field: 'count' }, 'equals', '3');
    await expect(
      r.evaluate('p', { field: 'count' }, 'equals', stored),
    ).resolves.toMatchObject({ status: 'holds' });
    await expect(
      r.evaluate('p', { field: 'count' }, 'equals', '3'),
    ).resolves.toMatchObject({ status: 'broken' });
  });
});

describe('the probes the platform ships with', () => {
  const app = {
    findOne: jest.fn(async () => ({ clusterId: 'c1', status: 'running' })),
    count: jest.fn(async () => 7),
  };
  const cluster = { findOne: jest.fn(async () => ({ nodeCount: 3 })) };
  const registry = new ContextProbeRegistry();

  beforeAll(() => {
    new BuiltinProbes(registry, app as never, cluster as never).onModuleInit();
  });

  it('registers three, each describing itself', () => {
    expect(registry.list().map((p) => p.id)).toEqual([
      'app.field',
      'cluster.appCount',
      'cluster.field',
    ]);
    expect(registry.list().every((p) => p.describes.length > 10)).toBe(true);
  });

  it('answers about an application’s placement', async () => {
    await expect(
      registry.evaluate(
        'app.field',
        { slug: 'shop', field: 'clusterId' },
        'equals',
        'c1',
      ),
    ).resolves.toMatchObject({ status: 'holds' });
  });

  /**
   * The allow-list is the security half of the probe design: `env` holds an
   * application's secrets, and a probe is a mechanism whose answers are read
   * out to a model. A field outside the list is `unknown`, never a value.
   */
  it('refuses to read a field nobody allow-listed', async () => {
    expect(APP_READABLE_FIELDS).not.toContain('env');
    await expect(
      registry.evaluate(
        'app.field',
        { slug: 'shop', field: 'env' },
        'exists',
        null,
      ),
    ).resolves.toMatchObject({ status: 'unknown' });
  });

  /**
   * Each shipped field says what a premise about it means, so `replicas` is a
   * number and `status` is a string wherever the note was written from.
   */
  it('reads a premise in the type each shipped field answers', () => {
    expect(
      registry.interpret(
        'app.field',
        { slug: 'shop', field: 'replicas' },
        'equals',
        '2',
      ),
    ).toBe(2);
    expect(
      registry.interpret(
        'cluster.field',
        { clusterId: 'c1', field: 'autoscalingEnabled' },
        'equals',
        'true',
      ),
    ).toBe(true);
    expect(
      registry.interpret(
        'cluster.appCount',
        { clusterId: 'c1' },
        'atMost',
        '10',
      ),
    ).toBe(10);
  });

  it('refuses at write the field it would have refused at read, naming the ones it has', () => {
    expect(() =>
      registry.interpret(
        'app.field',
        { slug: 'shop', field: 'env' },
        'exists',
        null,
      ),
    ).toThrow(/replicas/);
  });

  /** A rule about an application that no longer exists is a rule that should break. */
  it('breaks a note about an application that is gone', async () => {
    app.findOne.mockResolvedValueOnce(null as never);
    await expect(
      registry.evaluate(
        'app.field',
        { slug: 'gone', field: 'clusterId' },
        'exists',
        null,
      ),
    ).resolves.toMatchObject({ status: 'broken' });
  });
});
