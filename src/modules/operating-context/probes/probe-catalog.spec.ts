import { ContextProbe } from './context-probe';
import {
  ProbeParam,
  probeCards,
  requireDeclaredPairs,
  taken,
} from './probe-catalog';

const TYPES: Record<string, 'string' | 'number'> = {
  status: 'string',
  replicas: 'number',
};

const TAKES: readonly ProbeParam[] = [
  { name: 'slug', required: true },
  { name: 'field', required: true, oneOf: Object.keys(TYPES) },
];

/** A probe of the shape the platform ships: it declares, and it enforces. */
const shipped = (): ContextProbe => ({
  id: 'app.field',
  describes: 'One readable field of an application.',
  takes: TAKES,
  answers: (p) => TYPES[taken(p, TAKES, 'field')],
  run: async (p) => taken(p, TAKES, 'slug'),
});

/** A probe offered by another module that never said what it wants. */
const silent = (): ContextProbe => ({
  id: 'other.thing',
  describes: 'Something this module knows nothing about.',
  run: async () => 1,
});

describe('what the catalogue publishes', () => {
  it('names the parameters a probe asks for, and which it will not go without', () => {
    const [card] = probeCards([shipped()]);
    expect(card.takes).toEqual([
      { name: 'slug', required: true },
      { name: 'field', required: true, oneOf: ['status', 'replicas'] },
    ]);
  });

  /**
   * The point of the whole card. Until it existed the catalogue said `id` and
   * `describes`, so a form could not know `app.field` wants a `slug` — and the
   * write refuses without one.
   */
  it('says enough for a note to be composed without guessing', () => {
    const [card] = probeCards([shipped()]);
    const required = (card.takes ?? [])
      .filter((p) => p.required)
      .map((p) => p.name);
    expect(required).toEqual(['slug', 'field']);
  });

  it('asks the probe for the type each accepted value answers in, rather than being told', () => {
    const [card] = probeCards([shipped()]);
    expect(card.answersPer).toEqual({
      param: 'field',
      types: { status: 'string', replicas: 'number' },
    });
    expect(card.answers).toBeUndefined();
  });

  it('states one type outright when the probe answers the same one whatever it is asked', () => {
    const [card] = probeCards([
      {
        id: 'cluster.appCount',
        describes: 'How many applications sit on a cluster.',
        takes: [{ name: 'clusterId', required: true }],
        answers: () => 'number',
        run: async () => 2,
      },
    ]);
    expect(card.answers).toBe('number');
    expect(card.answersPer).toBeUndefined();
  });

  /**
   * *Takes nothing* and *did not say* are different instructions to an author:
   * the first means the question is complete, the second means they are on
   * their own — and a screen that showed an empty parameter list for the second
   * would be claiming a contract nobody wrote.
   */
  it('leaves the parameters absent, not empty, when the probe never declared them', () => {
    const [card] = probeCards([silent()]);
    expect('takes' in card).toBe(false);
    expect(card.answers).toBeUndefined();
    expect(card.answersPer).toBeUndefined();
  });

  it('publishes a value no probe answers a type for as a value with no type', () => {
    const takes: ProbeParam[] = [
      { name: 'field', required: true, oneOf: ['status', 'secretEnv'] },
    ];
    const [card] = probeCards([
      {
        id: 'p',
        describes: 'x',
        takes,
        answers: (p) =>
          taken(p, takes, 'field') === 'status' ? 'string' : undefined,
        run: async () => null,
      },
    ]);
    expect(card.answersPer?.types).toEqual({ status: 'string' });
  });

  /**
   * The catalogue is served to anybody who may read an application, which
   * includes people who do not run the installation. What a note leans on is a
   * field *name*; what the field contains is state, and it is not here.
   */
  it('publishes nothing but what a premise is composed of', () => {
    const [card] = probeCards([shipped()]);
    expect(Object.keys(card).sort()).toEqual([
      'answersPer',
      'describes',
      'id',
      'takes',
    ]);
  });
});

describe('reading a declared parameter', () => {
  it('refuses a required parameter that was not supplied, by name', () => {
    expect(() => taken({ field: 'status' }, TAKES, 'slug')).toThrow(
      'slug is missing',
    );
  });

  it('answers nothing for an optional one, rather than refusing', () => {
    const takes: ProbeParam[] = [{ name: 'clusterName', required: false }];
    expect(taken({}, takes, 'clusterName')).toBe('');
  });

  it('refuses a value outside the set, and says which are inside it', () => {
    expect(() => taken({ field: 'env' }, TAKES, 'field')).toThrow(
      /is not a field a note may lean on; the readable ones are status, replicas/,
    );
  });

  it('treats a blank as absent, so a form that posts empty boxes is refused honestly', () => {
    expect(() => taken({ slug: '   ' }, TAKES, 'slug')).toThrow(
      'slug is missing',
    );
  });

  it('refuses anything that is not text where text was declared', () => {
    expect(() => taken({ slug: 7 }, TAKES, 'slug')).toThrow('slug is missing');
  });

  /** A parameter nobody declared is this module's mistake, not the author's. */
  it('says so when asked for a parameter that was never declared', () => {
    expect(() => taken({ other: 'x' }, TAKES, 'other')).toThrow(
      /nothing here reads a parameter called other/,
    );
  });
});

/**
 * The gap that was declared open and stayed open for two rounds: a cluster is
 * named by its id **or** by its name, and the vocabulary could not say it. The
 * rule lived in a function beside the probe, so the *published card* told a
 * caller both parameters were optional while the runtime refused a call that
 * sent neither — a refusal the catalogue had given nobody a way to foresee.
 *
 * Closed pairwise and no wider. A third alternative is when to generalise; this
 * field will not express it, which is how that day announces itself.
 */
describe('a parameter that another may stand in for', () => {
  const PAIR: readonly ProbeParam[] = [
    { name: 'field', required: true },
    { name: 'clusterId', required: false, orElse: 'clusterName' },
    { name: 'clusterName', required: false, orElse: 'clusterId' },
  ];

  it('accepts either one', () => {
    expect(() =>
      requireDeclaredPairs({ clusterId: 'c-1' }, PAIR),
    ).not.toThrow();
    expect(() =>
      requireDeclaredPairs({ clusterName: 'prod' }, PAIR),
    ).not.toThrow();
  });

  it('accepts both', () => {
    expect(() =>
      requireDeclaredPairs({ clusterId: 'c-1', clusterName: 'prod' }, PAIR),
    ).not.toThrow();
  });

  it('refuses neither, naming both', () => {
    expect(() => requireDeclaredPairs({}, PAIR)).toThrow(
      'clusterId or clusterName is missing',
    );
  });

  /** Whitespace is not an answer — `taken` already trims, and this rides on it. */
  it('refuses a blank one', () => {
    expect(() => requireDeclaredPairs({ clusterId: '   ' }, PAIR)).toThrow(
      'is missing',
    );
  });

  /**
   * A declaration that names an alternative nothing reads is a typo that would
   * otherwise make the pair unsatisfiable at runtime and perfectly plausible on
   * the published card.
   */
  it('refuses a declaration that names an alternative nobody reads', () => {
    expect(() =>
      requireDeclaredPairs({ clusterId: 'c-1' }, [
        { name: 'clusterId', required: false, orElse: 'clusterNaem' },
      ]),
    ).toThrow('nothing here reads clusterNaem');
  });

  it('says nothing about a declaration with no alternatives', () => {
    expect(() => requireDeclaredPairs({}, TAKES)).not.toThrow();
  });

  /** The card publishes it, which is the whole point of moving the rule here. */
  it('reaches the published card', () => {
    const probe: ContextProbe = {
      id: 'cluster.field',
      describes: 'a field of a cluster',
      takes: PAIR,
      answers: () => 'string',
      run: async () => 'x',
    };
    const card = probeCards([probe])[0];
    expect(card.takes).toContainEqual({
      name: 'clusterId',
      required: false,
      orElse: 'clusterName',
    });
  });
});
