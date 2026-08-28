import type {
  ProviderScalingCapabilityDto,
  ScalingDecisionResponseDto,
  ScalingGroupResponseDto,
} from 'src/modules/infrastructure/scaling/dto/scaling-response.dto';
import {
  dumpScalingGroupDocument,
  parseScalingGroupFile,
} from './scaling-file';
import {
  FLOOR_MARK,
  NO_ANSWER,
  NO_PRICE,
  boundRows,
  capabilityLabel,
  describeActuation,
  describeCapability,
  describeChosen,
  describeClusterSilence,
  describeDecision,
  describeDrain,
  describeMonthlySpend,
  describePending,
  describeSilence,
  describeStandingOrder,
  describeStrategy,
  formatEurPerHour,
  formatEurPerMonth,
  groupNames,
  ladderRows,
  monthlySpendCell,
  outcomeMeaning,
  pendingPodsCell,
  pendingPodsWarns,
  toScalingGroupDocument,
} from './scaling-view';

const hetzner: ProviderScalingCapabilityDto = {
  provider: 'hetzner',
  canProvision: true,
  hasCatalogue: true,
  billing: 'hourly',
};

const contabo: ProviderScalingCapabilityDto = {
  provider: 'contabo',
  canProvision: false,
  hasCatalogue: true,
  billing: 'monthly',
};

const byos: ProviderScalingCapabilityDto = {
  provider: 'byos',
  canProvision: false,
  hasCatalogue: false,
  billing: 'none',
};

const group = (
  over: Partial<ScalingGroupResponseDto> = {},
): ScalingGroupResponseDto => ({
  id: '2f1c9e5a-0000-4000-8000-000000000001',
  name: 'general',
  clusterId: '2f1c9e5a-0000-4000-8000-0000000000aa',
  clusterName: 'prod-eu',
  provider: 'hetzner',
  capability: hetzner,
  bounds: { min: 1, desired: 3, max: 5 },
  regions: ['fsn1', 'nbg1'],
  shapes: ['cx32', 'cpx31'],
  strategy: 'cheapest',
  settleSeconds: 45,
  limits: { hourlyBillingOnly: true, maxMonthlyCost: 40 },
  provision: 'automatic',
  acts: {
    acts: true,
    says: 'This installation may commit up to €200 a month on its own, and only through groups set to buy automatically.',
    monthlyEur: 200,
  },
  standingOrders: [
    {
      kind: 'expand',
      shape: 'cx32',
      region: 'fsn1',
      wanted: 2,
      replaces: null,
      outlook: null,
      drainable: null,
    },
  ],
  requirement: null,
  ...over,
});

const decision = (
  over: Partial<ScalingDecisionResponseDto> = {},
): ScalingDecisionResponseDto => ({
  id: '2f1c9e5a-0000-4000-8000-000000000002',
  at: '2026-08-27T02:14:00.000Z',
  force: 'urgency',
  outcome: 'declined',
  saw: '1 unit of work waiting for 62s',
  did: 'nothing',
  why: 'the work has not been stuck long enough to be sure it is stuck',
  asks: null,
  shape: null,
  region: null,
  hourlyEur: null,
  considered: [],
  ...over,
});

describe('prices', () => {
  // The distinction the whole surface rests on: a price of nothing is not a
  // price of zero, and a fleet Flui is not billed for must never read as free.
  it('shows an absent price as no price at all, and zero as zero', () => {
    expect(formatEurPerHour(null)).toBe(NO_PRICE);
    expect(formatEurPerMonth(null)).toBe(NO_PRICE);
    expect(formatEurPerHour(0)).toBe('€0.0000/h');
    expect(formatEurPerMonth(0)).toBe('€0.00/mo');
  });
});

describe('describeCapability', () => {
  it('says a provider that can buy, buys', () => {
    expect(describeCapability(hetzner)).toContain('can add servers');
    expect(capabilityLabel(hetzner)).toBe('can buy');
  });

  // Read from the flags, never from the name: a catalogue without a create API
  // is not a lesser Hetzner, it is a different sentence with a shape in it.
  it('says a provider with a catalogue and no create API asks a person, by name', () => {
    expect(describeCapability(contabo)).toContain('naming the shape');
    expect(capabilityLabel(contabo)).toBe('alarm (named)');
  });

  it('says a provider with no catalogue can only describe the machine', () => {
    expect(describeCapability(byos)).toContain('what the machine has to hold');
    expect(capabilityLabel(byos)).toBe('alarm (described)');
  });
});

describe('describeStrategy', () => {
  // Fitting is the precondition; the strategies only choose among what already
  // fits. Said in the same breath, every time, or the model is taught wrong.
  it('says every strategy chooses among the shapes that already fit', () => {
    for (const strategy of [
      'cheapest',
      'closest',
      'roomiest',
      'uniform',
    ] as const) {
      expect(describeStrategy(strategy)).toContain('already fit');
    }
  });
});

describe('describeDecision', () => {
  it('renders a decline with its reason as the substance', () => {
    const view = describeDecision(
      decision(),
      new Date('2026-08-27T02:16:00.000Z'),
    );
    expect(view.headline).toBe('declined · urgency');
    expect(view.age).toBe('2m ago');
    expect(view.lines.map((l) => l.label)).toEqual(['saw', 'did', 'why']);
    expect(view.lines[2].text).toContain('not been stuck long enough');
  });

  it('renders an alarm with the sentence addressed to a person', () => {
    const view = describeDecision(
      decision({
        outcome: 'alerted',
        did: 'raised an alarm: Flui cannot add servers on byos',
        why: 'there is no way to create a machine on byos',
        asks: 'Add a machine holding at least 2 cpu and 8Gi, then connect it with `flui node connect`.',
      }),
    );
    expect(view.lines.map((l) => l.label)).toEqual([
      'saw',
      'did',
      'why',
      'asks',
    ]);
    expect(view.lines[3].text).toContain('flui node connect');
  });

  // The two lose for opposite reasons — one is the market, one is this group's
  // own rules — and collapsing them makes a policy look like an outage.
  it('keeps a shape refused by the group apart from one over budget', () => {
    const view = describeDecision(
      decision({
        considered: [
          {
            shape: 'cx32',
            region: 'fsn1',
            hourlyEur: 0.0074,
            outcome: 'refused-by-limit',
          },
          {
            shape: 'cpx41',
            region: 'nbg1',
            hourlyEur: 0.0298,
            outcome: 'over-budget',
          },
        ],
      }),
    );
    expect(view.candidates[0].reason).toContain('own rules');
    expect(view.candidates[1].reason).toContain('monthly ceiling');
    expect(view.candidates[0].price).toBe('€0.0074/h');
  });

  it('shows a candidate with no price as no price, not as free', () => {
    const view = describeDecision(
      decision({
        considered: [
          {
            shape: null,
            region: null,
            hourlyEur: null,
            outcome: 'alert',
            note: 'no catalogue to read here',
          },
        ],
      }),
    );
    expect(view.candidates[0].price).toBe(NO_PRICE);
    expect(view.candidates[0].reason).toBe('no catalogue to read here');
  });
});

describe('describeSilence', () => {
  it('explains that a decision is written even when nothing is done', () => {
    expect(describeSilence(group()).join(' ')).toContain(
      'decides to do nothing',
    );
  });

  it('says up front that an installation that cannot buy will only ever ask', () => {
    const said = describeSilence(
      group({ capability: byos, provider: 'byos', provision: 'manual' }),
    ).join(' ');
    expect(said).toContain('cannot add servers');
  });
});

describe('toScalingGroupDocument', () => {
  it('drops what the API reads from the world and keeps what somebody wrote', () => {
    const doc = toScalingGroupDocument(group());
    expect(doc).not.toHaveProperty('id');
    expect(doc).not.toHaveProperty('capability');
    expect(doc).not.toHaveProperty('provider');
    expect(doc.cluster).toBe('prod-eu');
    expect(
      (doc.standingOrders as Record<string, unknown>[])[0],
    ).not.toHaveProperty('outlook');
  });

  // The property that makes the file the source of truth: what comes out goes
  // back in unchanged, so a group can be exported, reviewed, committed, applied.
  it('round-trips through the parser without changing the group', () => {
    const exported = dumpScalingGroupDocument(toScalingGroupDocument(group()));
    const [parsed] = parseScalingGroupFile(exported);

    expect(parsed.cluster).toBe('prod-eu');
    expect(parsed.group).toEqual({
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

  it('round-trips a group written where no catalogue names shapes', () => {
    const exported = dumpScalingGroupDocument(
      toScalingGroupDocument(
        group({
          capability: byos,
          provider: 'byos',
          clusterName: 'my-servers',
          regions: [],
          shapes: [],
          standingOrders: [],
          provision: 'manual',
          strategy: 'uniform',
          limits: { hourlyBillingOnly: false, maxMonthlyCost: null },
          requirement: { cpu: '2', memory: '8Gi' },
        }),
      ),
    );
    const [parsed] = parseScalingGroupFile(exported);
    expect(parsed.group.requirement).toEqual({ cpu: '2', memory: '8Gi' });
    expect(parsed.group.limits.maxMonthlyCost).toBeNull();
  });
});

describe('the ceiling of a fleet that should hold no nodes', () => {
  const ceilingOf = (max: number, provision: 'automatic' | 'manual') =>
    boundRows({ min: 0, desired: 0, max }, provision)[2];

  // Refused by the CLI until now, so the sentence had nowhere to live either.
  it('reads 0 as a statement about the fleet, not as a group switched off', () => {
    expect(ceilingOf(0, 'manual').value).toBe(0);
    expect(ceilingOf(0, 'manual').meaning).toContain('somebody attached');
    expect(ceilingOf(0, 'automatic').meaning).toContain('buy nothing');
  });

  it('leaves every other ceiling saying what it always said', () => {
    expect(ceilingOf(5, 'automatic').meaning).toContain('urgency may go');
  });
});

describe('what a monthly figure is', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      capability: hetzner,
      nodes: 3,
      monthlyEur: 48,
      unpricedNodes: 0,
      ...over,
    }) as unknown as Parameters<typeof describeMonthlySpend>[0];

  it('marks a partly priced fleet as a floor rather than as the bill', () => {
    expect(monthlySpendCell(row({ unpricedNodes: 1 }))).toBe(
      `€48.00${FLOOR_MARK}`,
    );
    const said = describeMonthlySpend(row({ unpricedNodes: 1 }));
    expect(said).toContain('floor, not the bill');
    expect(said).toContain('1 of 3');
  });

  it('shows a fully priced fleet as the figure it is', () => {
    expect(monthlySpendCell(row())).toBe('€48.00');
    expect(describeMonthlySpend(row())).toContain('all 3 nodes');
  });

  // The two nulls are different answers, and only one of them may ever change.
  it('says a fleet Flui is never billed for has no bill, permanently', () => {
    const said = describeMonthlySpend(
      row({ capability: byos, monthlyEur: null, unpricedNodes: 3 }),
    );
    expect(said).toContain('permanent');
    expect(said).not.toContain('yet');
    expect(monthlySpendCell(row({ monthlyEur: null }))).toBe(NO_PRICE);
  });

  it('says an unpriced fleet has no figure yet, and is not free', () => {
    const said = describeMonthlySpend(
      row({ monthlyEur: null, unpricedNodes: 3 }),
    );
    expect(said).toContain('no node here carries a price yet');
    expect(said).toContain('not a fleet that costs nothing');
  });
});

describe('groupNames', () => {
  // A count leaves the second group unnamed, which is the group nobody knows about.
  it('names the groups a row carries instead of counting them', () => {
    expect(
      groupNames({
        groupCount: 2,
        groups: [
          { id: 'g1', name: 'general' },
          { id: 'g2', name: 'heavy' },
        ],
      } as unknown as Parameters<typeof groupNames>[0]),
    ).toBe('general, heavy');
  });

  it('says none rather than 0 when no group is configured', () => {
    expect(
      groupNames({ groupCount: 0, groups: [] } as unknown as Parameters<
        typeof groupNames
      >[0]),
    ).toBe('none');
  });
});

describe('describeClusterSilence', () => {
  it('tells a cluster with no group from a cluster nobody has evaluated', () => {
    const none = describeClusterSilence([]).join(' ');
    expect(none).toContain('No scaling group on this cluster');
    expect(none).toContain('raise no alarm');

    const quiet = describeClusterSilence([group(), group({ name: 'heavy' })]);
    expect(quiet[0]).toContain('2 groups');
    expect(quiet[0]).toContain('decides to do nothing');
  });

  it('says up front which groups will only ever ask a person', () => {
    const said = describeClusterSilence([
      group(),
      group({ name: 'attached', capability: byos, provider: 'byos' }),
    ]).join(' ');
    expect(said).toContain('attached: Flui cannot add servers on byos');
  });
});

/**
 * The question somebody opening a scaling group actually has. Two keys turn
 * this lock — the group's own mode, and the spending this installation granted
 * from outside the product — and a surface showing one of them is a surface
 * that says a group is armed when it buys nothing.
 */
describe('describeActuation', () => {
  it('answers yes or no, and carries the API’s sentence untouched', () => {
    const acting = describeActuation(group());
    expect(acting?.acts).toBe(true);
    expect(acting?.verdict).toBe('yes');
    expect(acting?.says).toBe(group().acts.says);
  });

  // Automatic and granted nothing: the case that looks armed and buys nothing.
  it('says no for an automatic group the installation granted nothing', () => {
    const acting = describeActuation(
      group({
        provision: 'automatic',
        acts: {
          acts: false,
          says: 'Nothing may be bought without being asked: no spending was granted to this installation.',
          monthlyEur: null,
        },
      }),
    );
    expect(acting?.verdict).toBe('no');
    expect(acting?.says).toContain('no spending was granted');
  });

  /** No grant and a grant of nothing are two different instructions. */
  it('keeps “nothing granted” apart from “granted €0”', () => {
    const none = describeActuation(
      group({ acts: { acts: false, says: 'no grant', monthlyEur: null } }),
    );
    const zero = describeActuation(
      group({ acts: { acts: true, says: 'granted nothing', monthlyEur: 0 } }),
    );
    expect(none?.grant).toBe(NO_PRICE);
    expect(zero?.grant).toBe('€0.00/mo');
  });

  /** An installation one build behind said nothing, which is not "it does nothing". */
  it('answers nothing at all when the API sent no such block', () => {
    expect(describeActuation({ acts: undefined })).toBeNull();
  });
});

/**
 * The figure that is wrong in the direction nobody checks: a cluster that could
 * not be asked, printed as a cluster with nothing waiting.
 */
describe('pendingPodsCell', () => {
  it('never prints an unanswered cluster as 0', () => {
    expect(pendingPodsCell({ pendingPods: null })).toBe(NO_ANSWER);
    expect(pendingPodsCell({ pendingPods: null })).not.toBe('0');
    expect(pendingPodsWarns({ pendingPods: null })).toBe(true);
  });

  it('prints a real count as itself, and a real zero as zero', () => {
    expect(pendingPodsCell({ pendingPods: 3 })).toBe('3');
    expect(pendingPodsCell({ pendingPods: 0 })).toBe('0');
    expect(pendingPodsWarns({ pendingPods: 3 })).toBe(true);
    expect(pendingPodsWarns({ pendingPods: 0 })).toBe(false);
  });
});

/**
 * A replacement whose node cannot be emptied waits for a machine it will never
 * buy. Nothing else on the screen tells that apart from patience, so the
 * refusal is never a flag: every blocker names the thing and the fix.
 */
describe('describeDrain', () => {
  const refused = {
    ok: false,
    blockers: [
      {
        kind: 'bound-volume',
        what: 'flui-apps/postgres-0 → data',
        fix: 'The volume lives on this machine and does not follow the pod.',
      },
      {
        kind: 'dedicated-app',
        what: 'gitea',
        fix: 'gitea keeps its data on this machine. Back it up, then redeploy it elsewhere.',
      },
    ],
    cleared: [],
  };

  it('lists every blocker with what it is and what would have to change', () => {
    const view = describeDrain(refused);
    expect(view?.ok).toBe(false);
    expect(view?.headline).toContain('never proceed');
    expect(view?.blockers).toEqual([
      { what: refused.blockers[0].what, fix: refused.blockers[0].fix },
      { what: refused.blockers[1].what, fix: refused.blockers[1].fix },
    ]);
  });

  it('says a node that can be emptied can be emptied', () => {
    const view = describeDrain({ ok: true, blockers: [], cleared: ['a', 'b'] });
    expect(view?.ok).toBe(true);
    expect(view?.headline).toContain('can be emptied');
    expect(view?.cleared).toEqual(['a', 'b']);
  });

  /** Nothing was asked, which must never render as an answer of yes. */
  it('renders nothing at all where no check was made', () => {
    expect(describeDrain(null)).toBeNull();
    expect(describeDrain(undefined)).toBeNull();
  });
});

describe('describeStandingOrder', () => {
  it('names the node a replacement would drain', () => {
    expect(
      describeStandingOrder({
        kind: 'replace',
        shape: 'cx32',
        region: 'fsn1',
        wanted: 1,
        replaces: 'worker-3',
        outlook: null,
        drainable: null,
      }),
    ).toBe('1 × cx32 at fsn1, draining worker-3');
  });

  it('leaves an expansion saying only what it buys, because it drains nothing', () => {
    expect(
      describeStandingOrder({
        kind: 'expand',
        shape: 'cx32',
        region: 'fsn1',
        wanted: 2,
        replaces: null,
        outlook: null,
        drainable: null,
      }),
    ).toBe('2 × cx32 at fsn1');
  });
});

/**
 * A decision that reached a provider renders exactly like one that did not: the
 * same four lines, and the reason carried whole. `why` is where the gate that
 * let it through — or stopped it — is said, and it is the whole of the answer.
 */
describe('describeDecision on the decisions that acted', () => {
  it('renders a purchase, saying what it committed and against what', () => {
    const view = describeDecision(
      decision({
        outcome: 'added',
        did: 'Bought a cx32 in fsn1 and set it to join.',
        why: 'About €62 a month against the €200 granted.',
        shape: 'cx32',
        region: 'fsn1',
        hourlyEur: 0.0074,
      }),
    );
    expect(view.headline).toBe('added · urgency');
    expect(view.lines[2].text).toBe(
      'About €62 a month against the €200 granted.',
    );
    expect(view.lines[3].text).toBe('cx32 at fsn1 · €0.0074/h');
    expect(outcomeMeaning('added')).toContain('added');
  });

  it('renders a node going back the same way', () => {
    const view = describeDecision(
      decision({
        force: 'opportunity',
        outcome: 'removed',
        did: 'Removed worker-3.',
        why: 'The fleet is above its target and the node can be emptied.',
      }),
    );
    expect(view.headline).toBe('removed · opportunity');
    expect(view.lines[1].text).toBe('Removed worker-3.');
    expect(outcomeMeaning('removed')).toContain('drained and removed');
  });

  /** The gate is the substance of a refusal, so it is never shortened. */
  it('carries the whole of a refusal, word for word', () => {
    const refusal =
      'Buying it would commit about €260 a month against the €200 this installation granted. ' +
      'This installation may commit up to €200 a month on its own, and only through groups set to buy automatically.';
    const view = describeDecision(decision({ why: refusal }));
    expect(view.lines[2].text).toBe(refusal);
  });
});

describe('the preview — what it would do, spending nothing', () => {
  const preview = (over: Record<string, unknown> = {}) =>
    ({
      groupId: '2f1c9e5a-0000-4000-8000-000000000001',
      pending: null,
      opportunityHeldBecause: null,
      ladder: [],
      chosen: null,
      asks: null,
      ...over,
    }) as unknown as Parameters<typeof ladderRows>[0];

  it('names the largest request the scheduler could not place', () => {
    expect(
      describePending(
        preview({
          pending: {
            app: 'flui-apps/checkout-7d8f',
            cpu: '500m',
            memory: '4096Mi',
          },
        }),
      ),
    ).toBe('flui-apps/checkout-7d8f · 500m cpu · 4096Mi');
  });

  // Two states share one absence, and only one of them may be read as calm.
  it('reads an empty preview as calm only when nothing is holding it', () => {
    expect(describePending(preview())).toContain('nothing was waiting');
    expect(
      describePending(
        preview({
          opportunityHeldBecause:
            'The cluster could not be asked whether anything is waiting.',
        }),
      ),
    ).toContain('not the same as nothing waiting');
  });

  it('walks the whole ladder and says why each rung lost', () => {
    const rows = ladderRows(
      preview({
        ladder: [
          {
            step: 1,
            describes: 'cx32 in fsn1',
            shape: 'cx32',
            region: 'fsn1',
            hourlyEur: 0.0074,
            outcome: 'refused-by-limit',
          },
          {
            step: 2,
            describes: 'cpx41 in nbg1',
            shape: 'cpx41',
            region: 'nbg1',
            hourlyEur: null,
            outcome: 'would-buy',
            note: 'the first that fits',
          },
        ],
      }),
    );
    expect(rows[0].reason).toContain('own rules');
    expect(rows[1].price).toBe(NO_PRICE);
    expect(rows[1].reason).toBe('the first that fits');
  });

  it('says an alarm is an alarm rather than showing an empty purchase', () => {
    expect(describeChosen(preview())).toContain('an alarm, not a purchase');
    expect(
      describeChosen(
        preview({
          chosen: {
            step: 1,
            describes: 'cx32 in fsn1',
            shape: 'cx32',
            region: 'fsn1',
            hourlyEur: 0.0074,
            outcome: 'would-buy',
          },
        }),
      ),
    ).toBe('cx32 at fsn1 · €0.0074/h');
  });
});
