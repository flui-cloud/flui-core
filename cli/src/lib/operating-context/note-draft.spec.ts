import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProbeCard } from '../../../../src/modules/operating-context/probes/probe-catalog';
import { probeCards } from '../../../../src/modules/operating-context/probes/probe-catalog';
import { ContextProbeRegistry } from '../../../../src/modules/operating-context/probes/context-probe';
import { BuiltinProbes } from '../../../../src/modules/operating-context/probes/builtin-probes';
import {
  NoteDraft,
  answerTypeOf,
  asksOf,
  opsFor,
  paramPairs,
  readExpected,
  whatIsStillMissing,
  writeBodyOf,
} from './note-draft';

/**
 * The cards below are **invented**, and that is the point: the CLI composes a
 * note out of whatever the catalogue publishes, so a test written against the
 * three facts this release happens to ship would prove the weaker thing.
 */
const declared: ProbeCard = {
  id: 'fake.thing',
  describes: 'a made-up fact',
  takes: [
    { name: 'where', required: true },
    { name: 'which', required: true, oneOf: ['size', 'name'] },
    { name: 'spare', required: false },
  ],
  answersPer: { param: 'which', types: { size: 'number', name: 'string' } },
};

const flat: ProbeCard = {
  id: 'fake.count',
  describes: 'a made-up count',
  takes: [{ name: 'where', required: true }],
  answers: 'number',
};

/** A probe from another module that never said what it takes or answers. */
const silent: ProbeCard = { id: 'other.thing', describes: 'says nothing' };

const draft = (over: Partial<NoteDraft> = {}): NoteDraft => ({
  scopeType: 'global',
  nature: 'practice',
  topic: 'placement',
  title: 'Where things go',
  body: 'They go here.',
  checkKind: 'none',
  ...over,
});

describe('the questions a published fact asks', () => {
  it('turns each published parameter into one question, in order', () => {
    expect(asksOf(declared)).toEqual([
      { name: 'where', required: true },
      { name: 'which', required: true, choices: ['size', 'name'] },
      { name: 'spare', required: false },
    ]);
  });

  it('keeps “takes nothing” apart from “never said”', () => {
    expect(asksOf(silent)).toBeNull();
    expect(asksOf({ id: 'x', describes: 'y', takes: [] })).toEqual([]);
  });
});

describe('the type the answer comes back in', () => {
  it('reads the flat type when the fact publishes one', () => {
    expect(answerTypeOf(flat, {})).toBe('number');
  });

  it('reads the type of the question, not of the fact', () => {
    expect(answerTypeOf(declared, { which: 'size' })).toBe('number');
    expect(answerTypeOf(declared, { which: 'name' })).toBe('string');
  });

  it('says nothing when the deciding parameter is unanswered', () => {
    expect(answerTypeOf(declared, {})).toBeUndefined();
  });

  it('says nothing for a fact that published no type', () => {
    expect(answerTypeOf(silent, { which: 'size' })).toBeUndefined();
  });
});

describe('which comparisons are offered', () => {
  it('offers ordering only where the answer is a number', () => {
    expect(opsFor('number')).toContain('atLeast');
    expect(opsFor('string')).not.toContain('atLeast');
    expect(opsFor('string')).not.toContain('atMost');
    expect(opsFor('boolean')).not.toContain('atMost');
  });

  it('offers all five when nothing published a type', () => {
    expect(opsFor(undefined)).toHaveLength(5);
  });

  it('keeps equality and presence whatever the type', () => {
    for (const type of ['string', 'boolean', 'number', undefined] as const) {
      expect(opsFor(type)).toEqual(
        expect.arrayContaining(['equals', 'notEquals', 'exists']),
      );
    }
  });
});

describe('reading what was typed in the type the fact answers', () => {
  it('reads a number as a number', () => {
    expect(readExpected('number', ' 2 ')).toEqual({ value: 2 });
    expect(readExpected('number', '-1.5')).toEqual({ value: -1.5 });
  });

  it('refuses a number that is not one, before anything is sent', () => {
    const read = readExpected('number', 'three');
    expect('problem' in read && read.problem).toContain('not one');
  });

  it('reads true and false as themselves', () => {
    expect(readExpected('boolean', 'TRUE')).toEqual({ value: true });
    expect(readExpected('boolean', 'false')).toEqual({ value: false });
    expect('problem' in readExpected('boolean', 'maybe')).toBe(true);
  });

  // A digit string against a text field stays text: the API knows the type and
  // the CLI does not get to improve on it.
  it('hands a string over exactly as written', () => {
    expect(readExpected('string', ' 12 ')).toEqual({ value: '12' });
  });

  it('hands an undeclared premise over exactly as written', () => {
    expect(readExpected(undefined, '12')).toEqual({ value: '12' });
    expect(readExpected(undefined, 'about three')).toEqual({
      value: 'about three',
    });
  });

  it('refuses an empty premise and names the comparison that wants none', () => {
    const read = readExpected('string', '   ');
    expect('problem' in read && read.problem).toContain('exists');
  });
});

describe('the body that is posted', () => {
  it('sends nothing about a check the note does not carry', () => {
    const body = writeBodyOf(
      draft({ probeId: 'fake.thing', validForDays: 30 }),
    );
    expect(body.probeId).toBeUndefined();
    expect(body.probeParams).toBeUndefined();
    expect(body.validForDays).toBeUndefined();
  });

  it('sends the shelf life only for an attested note', () => {
    expect(
      writeBodyOf(draft({ checkKind: 'attestation', validForDays: 30 }))
        .validForDays,
    ).toBe(30);
  });

  it('sends no expected value with “exists”', () => {
    const body = writeBodyOf(
      draft({
        checkKind: 'probe',
        probeId: 'fake.count',
        probeParams: { where: 'c1' },
        probeOp: 'exists',
        probeExpected: 3,
      }),
    );
    expect(body.probeOp).toBe('exists');
    expect('probeExpected' in body).toBe(false);
  });

  it('sends the level and leaves out what the level does not carry', () => {
    const body = writeBodyOf(draft());
    expect(body.scopeType).toBe('global');
    expect('scopeRef' in body).toBe(false);
    expect('selector' in body).toBe(false);
  });
});

describe('what is still missing, said before anything is sent', () => {
  const probed = (over: Partial<NoteDraft> = {}): NoteDraft =>
    draft({
      checkKind: 'probe',
      probeId: declared.id,
      probeOp: 'equals',
      probeParams: { where: 'c1', which: 'name' },
      probeExpected: 'x',
      ...over,
    });

  it('finds nothing missing once every published question is answered', () => {
    expect(whatIsStillMissing(probed(), declared)).toBeNull();
  });

  it('names the unanswered question the fact published', () => {
    const missing = whatIsStillMissing(
      probed({ probeParams: { which: 'name' } }),
      declared,
    );
    expect(missing).toContain('where');
    expect(missing).toContain(declared.id);
  });

  it('refuses a value outside the published set', () => {
    const missing = whatIsStillMissing(
      probed({ probeParams: { where: 'c1', which: 'colour' } }),
      declared,
    );
    expect(missing).toContain('size, name');
  });

  it('refuses ordering against an answer that is not a number', () => {
    const missing = whatIsStillMissing(
      probed({ probeOp: 'atLeast', probeExpected: 2 }),
      declared,
    );
    expect(missing).toContain('compares numbers');
  });

  it('allows ordering once the question answers a number', () => {
    expect(
      whatIsStillMissing(
        probed({
          probeParams: { where: 'c1', which: 'size' },
          probeOp: 'atLeast',
          probeExpected: 2,
        }),
        declared,
      ),
    ).toBeNull();
  });

  // The silence is deliberate: a CLI that guessed on behalf of a catalogue it
  // could not read would be exactly the drift the catalogue removed.
  it('says nothing about the check when no card was published', () => {
    expect(whatIsStillMissing(probed({ probeExpected: undefined }))).toBeNull();
  });

  it('asks for the level, the words and the shelf life in that order', () => {
    expect(
      whatIsStillMissing(draft({ scopeType: 'cluster', scopeRef: null })),
    ).toContain('names its cluster');
    expect(whatIsStillMissing(draft({ topic: ' ' }))).toContain('subject');
    expect(whatIsStillMissing(draft({ title: '' }))).toContain('title');
    expect(whatIsStillMissing(draft({ body: '' }))).toContain('note itself');
    expect(whatIsStillMissing(draft({ checkKind: 'attestation' }))).toContain(
      'how long',
    );
  });
});

describe('name=value pairs off the command line', () => {
  it('splits on the first equals and drops what has no name', () => {
    expect(paramPairs(['a=1', 'b=x=y', '=z', 'nope'])).toEqual({
      a: '1',
      b: 'x=y',
    });
  });
});

/**
 * The property the whole exercise is for: the CLI holds no second copy of what
 * a fact is called or what it accepts.
 *
 * Read off the shipped registry rather than off a list written here, so a probe
 * added tomorrow is covered without this file being reopened. Only the probe
 * ids and the published sets of accepted values are looked for — a parameter's
 * *name* is a word like `slug` that a terminal may legitimately print for other
 * reasons, and a sentinel that cried wolf about those would be turned off.
 *
 * Two narrowings, both of which are the sentinel being made honest rather than
 * lenient. It reads whole words: `port` is a field a note may lean on and also
 * the last four letters of `export`. And it covers the two files that compose a
 * note; `context-client.ts` is left out because it names the *focus* axes of a
 * query — `clusterId`, `slug` — which are the fence's vocabulary and happen to
 * collide with a field name, so including it would fail for a reason that has
 * nothing to do with the property being pinned.
 */
describe('no second copy of the probe contract', () => {
  const shipped = (): ProbeCard[] => {
    const registry = new ContextProbeRegistry();
    new BuiltinProbes(registry, null as never, null as never).onModuleInit();
    return probeCards(registry.list());
  };

  const source = (file: string): string =>
    fs.readFileSync(path.join(__dirname, file), 'utf8');

  it('never names a shipped fact or one of its accepted values', () => {
    const cards = shipped();
    expect(cards.length).toBeGreaterThan(0);

    const forbidden = new Set<string>();
    for (const card of cards) {
      forbidden.add(card.id);
      for (const param of card.takes ?? []) {
        for (const value of param.oneOf ?? []) forbidden.add(value);
      }
    }
    expect(forbidden.size).toBeGreaterThan(5);

    for (const file of ['note-draft.ts', 'ask-note.ts']) {
      const text = source(file);
      for (const word of forbidden) {
        const whole = new RegExp(`\\b${word.replace('.', '\\.')}\\b`);
        expect({ file, word, found: whole.test(text) }).toEqual({
          file,
          word,
          found: false,
        });
      }
    }
  });
});
