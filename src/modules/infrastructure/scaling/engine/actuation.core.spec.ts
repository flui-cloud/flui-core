import { ScalingIntent } from '../scaling.core';
import {
  ActuationFacts,
  mayAct,
  HOLD_AFTER_ADD_MINUTES,
} from './actuation.core';

const add = (over: Partial<ScalingIntent> = {}): ScalingIntent => ({
  kind: 'add',
  shape: 'cx32',
  region: 'fsn1',
  hourlyEur: 0.0074,
  node: null,
  fleetMonthlyEur: 10,
  unpricedNodes: 0,
  fleetNodes: 2,
  ...over,
});

const remove = (over: Partial<ScalingIntent> = {}): ScalingIntent =>
  add({
    kind: 'remove',
    shape: null,
    region: null,
    hourlyEur: null,
    node: 'n-2',
    ...over,
  });

const facts = (over: Partial<ActuationFacts> = {}): ActuationFacts => ({
  canProvision: true,
  provision: 'automatic',
  clusterReady: true,
  purchaseInFlight: false,
  failedPurchase: null,
  minutesSinceAdded: null,
  clusterRegion: 'fsn1',
  reachableRegions: ['fsn1'],
  monthlyCap: 40,
  intent: add(),
  ...over,
});

describe('the gate between deciding and acting', () => {
  it('acts where the provider allows it and the group was set to', () => {
    const verdict = mayAct(facts());
    expect(verdict.act).toBe(true);
    expect(verdict.refusal).toBeNull();
  });

  it('needs the group to say it may act — that is the whole of the consent', () => {
    const verdict = mayAct(facts({ provision: 'manual' }));
    expect(verdict).toMatchObject({ act: false, refusal: 'group-is-manual' });
  });

  it('leaves the provider that cannot buy exactly where the engine left it', () => {
    const verdict = mayAct(facts({ canProvision: false }));
    expect(verdict).toMatchObject({
      act: false,
      refusal: 'provider-cannot-buy',
    });
  });

  it("refuses a removal on the operator's own machines for its own reason", () => {
    const verdict = mayAct(facts({ canProvision: false, intent: remove() }));
    expect(verdict.act).toBe(false);
    // Not the purchase sentence: nothing is being bought, and the reason a
    // machine stays is that only a person could put it back.
    expect(verdict.because).toContain('re-attach');
    expect(verdict.because).not.toContain('cannot create a server');
  });

  it('buys nothing while a machine is already on its way', () => {
    const verdict = mayAct(facts({ purchaseInFlight: true }));
    expect(verdict).toMatchObject({
      act: false,
      refusal: 'purchase-in-flight',
    });
    expect(verdict.because).toContain('one node a minute');
  });

  it('gives nothing back either, and says the fleet is about to change size', () => {
    const verdict = mayAct(facts({ purchaseInFlight: true, intent: remove() }));
    expect(verdict.act).toBe(false);
    expect(verdict.because).toContain('about to be a different size');
    expect(verdict.because).not.toContain('is bought');
  });

  it('buys nothing more after a purchase failed, and says what failed', () => {
    const verdict = mayAct(
      facts({
        failedPurchase: {
          at: new Date('2026-09-24T14:17:30Z'),
          error: 'no SSH key',
        },
      }),
    );
    expect(verdict).toMatchObject({
      act: false,
      refusal: 'last-purchase-failed',
    });
    expect(verdict.because).toContain('failed at 14:17 UTC: no SSH key.');
    expect(verdict.because).toContain('ask this group to try again');
  });

  it('says a sold-out order ends by itself, without asking anyone to try again', () => {
    const verdict = mayAct(
      facts({
        failedPurchase: {
          at: new Date('2026-09-24T14:17:30Z'),
          error:
            'Hetzner API Error: server type unavailable (resource_unavailable)',
          until: new Date('2026-09-24T14:27:30Z'),
        },
      }),
    );
    expect(verdict).toMatchObject({
      act: false,
      refusal: 'last-purchase-failed',
    });
    expect(verdict.because).toContain('nothing was created');
    expect(verdict.because).toContain('from 14:27 UTC');
    expect(verdict.because).not.toContain('try again');
  });

  /**
   * The same failure, read a minute apart, must say the same thing: a repeated
   * decision is only recognised as one while its sentence does not change.
   */
  it('says when as a time, so the answer does not change from one pass to the next', () => {
    const failed = { at: new Date('2026-09-24T14:17:30Z'), error: null };
    const first = mayAct(facts({ failedPurchase: failed })).because;
    const later = mayAct(facts({ failedPurchase: failed })).because;
    expect(first).toBe(later);
    expect(first).toContain('failed at 14:17 UTC.');
  });

  it('still gives back after a purchase failed — a removal buys nothing', () => {
    const verdict = mayAct(
      facts({
        intent: remove(),
        failedPurchase: { at: new Date('2026-09-24T14:17:30Z'), error: null },
      }),
    );
    expect(verdict.act).toBe(true);
  });

  it('gives back the node a replacement bought a stand-in for, without the pause', () => {
    const verdict = mayAct(
      facts({
        intent: remove({ completesReplacement: true }),
        minutesSinceAdded: 1,
        lastJoinedAt: new Date('2026-09-24T14:18:39Z'),
      }),
    );
    expect(verdict.refusal).not.toBe('just-added');
  });

  it('gives nothing back within the pause after a node has joined', () => {
    const verdict = mayAct(
      facts({
        intent: remove(),
        minutesSinceAdded: 3,
        lastJoinedAt: new Date('2026-09-24T14:18:39Z'),
      }),
    );
    expect(verdict.act).toBe(false);
    expect(verdict.refusal).toBe('just-added');
    expect(verdict.because).toContain(
      'A node joined at 14:18 UTC; nothing goes back before 14:28 UTC.',
    );
  });

  it('gives back once the pause has run out', () => {
    const verdict = mayAct(
      facts({ intent: remove(), minutesSinceAdded: HOLD_AFTER_ADD_MINUTES }),
    );
    expect(verdict.act).toBe(true);
  });

  /** The pause is about handing back, never about answering load. */
  it('still buys straight after a node has joined, if more is waiting', () => {
    const verdict = mayAct(facts({ intent: add(), minutesSinceAdded: 1 }));
    expect(verdict.act).toBe(true);
  });

  it('will not attach a machine to a cluster that is not ready for one', () => {
    const verdict = mayAct(facts({ clusterReady: false }));
    expect(verdict).toMatchObject({ act: false, refusal: 'cluster-not-ready' });
  });

  it('refuses a shape that won somewhere the cluster has no network', () => {
    const verdict = mayAct(facts({ intent: add({ region: 'nbg1' }) }));
    expect(verdict).toMatchObject({
      act: false,
      refusal: 'outside-the-network',
    });
    expect(verdict.because).toContain('nbg1');
  });

  /**
   * One network zone spans several regions: a node bought in any of them joins
   * the same private network. Buying only at home would stop the fleet growing
   * the moment home runs out, with the machine on offer next door.
   */
  it('buys in another region its network reaches', () => {
    const verdict = mayAct(
      facts({
        intent: add({ region: 'nbg1' }),
        reachableRegions: ['fsn1', 'nbg1', 'hel1'],
      }),
    );
    expect(verdict.act).toBe(true);
  });

  it('buys anywhere where geography fences nothing', () => {
    const verdict = mayAct(
      facts({ intent: add({ region: 'par1' }), reachableRegions: null }),
    );
    expect(verdict.act).toBe(true);
  });

  /**
   * The money ceiling lives on the ladder, which knows the fleet and refuses a
   * shape before it is ever chosen. What is left here is the one case the
   * ladder cannot judge: a shape with no published price passes its budget
   * check by default, and a group that named a ceiling did not agree to that.
   */
  it('will not honour a ceiling against a price it does not have', () => {
    const verdict = mayAct(facts({ intent: add({ hourlyEur: null }) }));
    expect(verdict).toMatchObject({ act: false, refusal: 'unpriced-purchase' });
    expect(verdict.because).toContain('€40');
  });

  it('buys an unpriced shape where the group named no ceiling at all', () => {
    const verdict = mayAct(
      facts({ monthlyCap: null, intent: add({ hourlyEur: null }) }),
    );
    expect(verdict.act).toBe(true);
  });

  it('does not ask a removal for a price or a region it has no use for', () => {
    expect(mayAct(facts({ intent: remove() })).act).toBe(true);
  });
});
