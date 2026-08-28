import { readConcession } from '../concession';
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

const facts = (over: Partial<ActuationFacts> = {}): ActuationFacts => ({
  canProvision: true,
  provision: 'automatic',
  concession: readConcession('40'),
  clusterReady: true,
  purchaseInFlight: false,
  clusterRegion: 'fsn1',
  intent: add(),
  ...over,
});

describe('the gate between deciding and spending', () => {
  it('buys when both keys turn and the money is inside the grant', () => {
    const verdict = mayAct(facts());
    expect(verdict.act).toBe(true);
    expect(verdict.refusal).toBeNull();
  });

  it('needs the group to say it may act, not only the installation', () => {
    const verdict = mayAct(facts({ provision: 'manual' }));
    expect(verdict).toMatchObject({ act: false, refusal: 'group-is-manual' });
  });

  it('needs the installation to say so, not only the group', () => {
    const verdict = mayAct(facts({ concession: readConcession(undefined) }));
    expect(verdict).toMatchObject({ act: false, refusal: 'no-concession' });
  });

  it("refuses a removal on the operator's own machines for its own reason", () => {
    const verdict = mayAct(
      facts({
        canProvision: false,
        intent: {
          kind: 'remove',
          shape: null,
          region: null,
          hourlyEur: null,
          node: 'n-2',
          fleetMonthlyEur: 0,
          unpricedNodes: 2,
          fleetNodes: 3,
        },
      }),
    );
    expect(verdict.act).toBe(false);
    // Not the purchase sentence: nothing is being bought, and the reason a
    // machine stays is that only a person could put it back.
    expect(verdict.because).toContain('re-attach');
    expect(verdict.because).not.toContain('cannot create a server');
  });

  it('leaves the provider that cannot buy exactly where the engine left it', () => {
    const verdict = mayAct(facts({ canProvision: false }));
    expect(verdict).toMatchObject({
      act: false,
      refusal: 'provider-cannot-buy',
    });
  });

  it('buys nothing while a machine is already on its way', () => {
    const verdict = mayAct(facts({ purchaseInFlight: true }));
    expect(verdict).toMatchObject({
      act: false,
      refusal: 'purchase-in-flight',
    });
  });

  it('says why waiting matters, because a pod stays pending for the whole of a provisioning', () => {
    expect(mayAct(facts({ purchaseInFlight: true })).because).toContain(
      'one node a minute',
    );
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

  it('will not honour a spending grant against a price it does not have', () => {
    const verdict = mayAct(facts({ intent: add({ hourlyEur: null }) }));
    expect(verdict).toMatchObject({
      act: false,
      refusal: 'unpriced-purchase',
    });
  });

  it('counts what the fleet already commits, not only what the new machine costs', () => {
    // The shape alone is about €5.40 a month and would clear €40 on its own.
    const verdict = mayAct(facts({ intent: add({ fleetMonthlyEur: 38 }) }));
    expect(verdict).toMatchObject({ act: false, refusal: 'over-concession' });
  });

  it('grants of zero refuse every purchase while still letting groups decide', () => {
    const verdict = mayAct(facts({ concession: readConcession('0') }));
    expect(verdict).toMatchObject({ act: false, refusal: 'over-concession' });
  });

  it('says the figure is a floor when part of the fleet carries no price', () => {
    const verdict = mayAct(facts({ intent: add({ unpricedNodes: 2 }) }));
    expect(verdict.act).toBe(true);
    expect(verdict.caveat).toContain('2 node(s)');
    expect(verdict.caveat).toContain('not proof');
  });

  it('says nothing extra when the whole fleet is priced', () => {
    expect(mayAct(facts()).caveat).toBeNull();
  });

  it('does not ask a removal for a price or a region it has no use for', () => {
    const verdict = mayAct(
      facts({
        intent: {
          kind: 'remove',
          shape: null,
          region: null,
          hourlyEur: null,
          node: 'n-2',
          fleetMonthlyEur: 10,
          unpricedNodes: 0,
          fleetNodes: 3,
        },
      }),
    );
    expect(verdict.act).toBe(true);
  });

  it('still refuses a removal the installation never granted', () => {
    const verdict = mayAct({
      ...facts({ concession: readConcession(undefined) }),
      intent: {
        kind: 'remove',
        shape: null,
        region: null,
        hourlyEur: null,
        node: 'n-2',
        fleetMonthlyEur: 10,
        unpricedNodes: 0,
        fleetNodes: 3,
      },
    });
    expect(verdict).toMatchObject({ act: false, refusal: 'no-concession' });
  });
});
