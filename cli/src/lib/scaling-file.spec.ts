import {
  ScalingDocumentError,
  parseScalingGroupDocument,
  parseScalingGroupFile,
} from './scaling-file';

const good = `
kind: ScalingGroup
name: general
cluster: prod-eu
bounds:
  min: 1
  desired: 3
  max: 5
regions: [fsn1, nbg1]
shapes: [cx32, cpx31]
strategy: cheapest
settleSeconds: 45
limits:
  hourlyBillingOnly: true
  maxMonthlyCost: 40
provision: automatic
standingOrders:
  - kind: expand
    shape: cx32
    region: fsn1
    wanted: 2
`;

function problemsOf(raw: string): string[] {
  try {
    parseScalingGroupFile(raw);
  } catch (error: unknown) {
    if (error instanceof ScalingDocumentError) return error.problems;
    throw error;
  }
  throw new Error('expected the document to be refused');
}

/**
 * The file is the group. What is defended here is that a typo cannot quietly
 * become a default, and that the three bounds keep their three meanings on the
 * way in — a file that says something incoherent about them is refused before
 * a request goes anywhere.
 */
describe('parseScalingGroupFile', () => {
  it('reads every field of a written group', () => {
    const [doc] = parseScalingGroupFile(good);
    expect(doc.cluster).toBe('prod-eu');
    expect(doc.group).toEqual({
      name: 'general',
      bounds: { min: 1, desired: 3, max: 5 },
      regions: ['fsn1', 'nbg1'],
      shapes: ['cx32', 'cpx31'],
      strategy: 'cheapest',
      settleSeconds: 45,
      limits: { hourlyBillingOnly: true, maxMonthlyCost: 40 },
      provision: 'automatic',
      standingOrders: [
        {
          kind: 'expand',
          shape: 'cx32',
          region: 'fsn1',
          wanted: 2,
          replaces: null,
        },
      ],
      requirement: null,
    });
  });

  it('fills the omitted fields with the same defaults the API would', () => {
    const [doc] = parseScalingGroupFile(
      'kind: ScalingGroup\nname: minimal\nbounds: {min: 1, desired: 1, max: 1}\n',
    );
    expect(doc.cluster).toBeNull();
    expect(doc.group.strategy).toBe('uniform');
    expect(doc.group.settleSeconds).toBe(30);
    expect(doc.group.provision).toBe('manual');
    expect(doc.group.limits).toEqual({
      hourlyBillingOnly: false,
      maxMonthlyCost: null,
    });
    expect(doc.group.regions).toEqual([]);
    expect(doc.group.shapes).toEqual([]);
    expect(doc.group.standingOrders).toEqual([]);
    expect(doc.group.requirement).toBeNull();
  });

  it('reads several groups out of one file', () => {
    const docs = parseScalingGroupFile(
      `${good}---\nkind: ScalingGroup\nname: heavy\ncluster: prod-eu\nbounds: {min: 0, desired: 0, max: 4}\n`,
    );
    expect(docs.map((d) => d.group.name)).toEqual(['general', 'heavy']);
  });

  it('refuses a document of another kind', () => {
    expect(problemsOf('kind: AccessPolicy\nname: x\n')).toContainEqual(
      expect.stringContaining('expected ScalingGroup'),
    );
  });

  // A file-shaped resource where a typo means "default" is a file that lies to
  // its reviewer: `shape:` would silently buy nothing in particular.
  it('refuses a misspelled field instead of defaulting it', () => {
    const problems = problemsOf(
      'kind: ScalingGroup\nname: g\nbounds: {min: 1, desired: 1, max: 1}\nshape: [cx32]\n',
    );
    expect(problems).toContain('unknown field `shape`');
  });

  it('refuses a floor above the target, naming both roles', () => {
    const problems = problemsOf(
      'kind: ScalingGroup\nname: g\nbounds: {min: 4, desired: 2, max: 5}\n',
    );
    expect(problems.join('\n')).toContain('held now and always');
  });

  it('refuses a target above the ceiling, naming both roles', () => {
    const problems = problemsOf(
      'kind: ScalingGroup\nname: g\nbounds: {min: 1, desired: 6, max: 5}\n',
    );
    expect(problems.join('\n')).toContain('as far as urgency may go');
  });

  // A ceiling of 0 is a fleet that should hold no nodes, and the reader used to
  // refuse it before the API was ever asked.
  it('accepts a ceiling of zero, with the other two roles at zero too', () => {
    const [doc] = parseScalingGroupFile(
      'kind: ScalingGroup\nname: attached\nbounds: {min: 0, desired: 0, max: 0}\n',
    );
    expect(doc.group.bounds).toEqual({ min: 0, desired: 0, max: 0 });
  });

  it('still refuses a target above a ceiling of zero', () => {
    const problems = problemsOf(
      'kind: ScalingGroup\nname: g\nbounds: {min: 0, desired: 1, max: 0}\n',
    );
    expect(problems.join('\n')).toContain('as far as urgency may go');
  });

  it('refuses a settle window long enough to be an outage', () => {
    const problems = problemsOf(
      'kind: ScalingGroup\nname: g\nbounds: {min: 1, desired: 1, max: 1}\nsettleSeconds: 5400\n',
    );
    expect(problems.join('\n')).toContain('outage with a timer on it');
  });

  it('keeps a cap of zero apart from no cap at all', () => {
    const [zero] = parseScalingGroupFile(
      'kind: ScalingGroup\nname: g\nbounds: {min: 1, desired: 1, max: 1}\nlimits: {maxMonthlyCost: 0}\n',
    );
    const [none] = parseScalingGroupFile(
      'kind: ScalingGroup\nname: g\nbounds: {min: 1, desired: 1, max: 1}\nlimits: {}\n',
    );
    expect(zero.group.limits.maxMonthlyCost).toBe(0);
    expect(none.group.limits.maxMonthlyCost).toBeNull();
  });

  it('reports every problem at once', () => {
    const problems = problemsOf(
      'kind: ScalingGroup\nbounds: {min: 2, desired: 1, max: 1}\nstrategy: cheepest\n',
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems).toContain('missing `name`');
  });

  it('accepts a requirement written without quotes', () => {
    const [doc] = parseScalingGroupFile(
      'kind: ScalingGroup\nname: g\nbounds: {min: 1, desired: 1, max: 1}\nrequirement: {cpu: 2, memory: 8Gi}\n',
    );
    expect(doc.group.requirement).toEqual({ cpu: '2', memory: '8Gi' });
  });
});

describe('standing orders', () => {
  const base =
    'kind: ScalingGroup\nname: g\nbounds: {min: 1, desired: 3, max: 3}\n' +
    'regions: [fsn1]\nshapes: [cx32]\n';

  it('refuses an expansion that names a node to replace', () => {
    const problems = problemsOf(
      `${base}standingOrders:\n  - {kind: expand, shape: cx32, region: fsn1, wanted: 1, replaces: worker-2}\n`,
    );
    expect(problems.join('\n')).toContain('names no node to replace');
  });

  it('refuses a replacement that names none', () => {
    const problems = problemsOf(
      `${base}standingOrders:\n  - {kind: replace, shape: cx32, region: fsn1, wanted: 1}\n`,
    );
    expect(problems.join('\n')).toContain('drain and remove');
  });

  // The order would wait for a purchase the group is not allowed to make, so
  // the wait could never end — and from the outside that is indistinguishable
  // from an outage.
  it('refuses an order waiting for a shape the group may not buy', () => {
    const problems = problemsOf(
      `${base}standingOrders:\n  - {kind: expand, shape: cx42, region: fsn1, wanted: 1}\n`,
    );
    expect(problems.join('\n')).toContain('could never end');
  });

  // Where no catalogue names shapes, `shapes` is empty on purpose — and an
  // order naming one there waits for a purchase that can never be made.
  it('refuses an order naming a shape when the group names none', () => {
    const problems = problemsOf(
      'kind: ScalingGroup\nname: g\nbounds: {min: 1, desired: 1, max: 1}\n' +
        'standingOrders:\n  - {kind: expand, shape: cx32, region: fsn1, wanted: 1}\n',
    );
    expect(problems.join('\n')).toContain('"cx32"');
    expect(problems.join('\n')).toContain('"fsn1"');
  });

  it('refuses an order waiting in a region the group may not buy in', () => {
    const problems = problemsOf(
      `${base}standingOrders:\n  - {kind: expand, shape: cx32, region: hel1, wanted: 1}\n`,
    );
    expect(problems.join('\n')).toContain('"hel1"');
  });
});

describe('parseScalingGroupDocument', () => {
  it('refuses anything that is not a block of fields', () => {
    expect(() => parseScalingGroupDocument('general')).toThrow(
      ScalingDocumentError,
    );
  });
});
