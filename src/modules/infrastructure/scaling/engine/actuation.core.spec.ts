import { ScalingIntent } from '../scaling.core';
import { ActuationFacts, mayAct } from './actuation.core';

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
  clusterRegion: 'fsn1',
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
