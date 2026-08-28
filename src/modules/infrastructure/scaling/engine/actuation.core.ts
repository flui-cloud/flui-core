import { SpendingConcession } from '../concession';
import { ProvisionMode, ScalingIntent } from '../scaling.core';
import { MONTH_HOURS, roundEur } from './engine.core';

/**
 * Why a decision stayed a decision.
 *
 * Named rather than described, because these are the sentences somebody reads
 * when a machine did not appear, and "it did nothing" is the answer that sends
 * them looking in the wrong place. Four of them mean *the installation said
 * no*, three mean *not right now*, and telling those apart is most of the value.
 */
export type ActuationRefusal =
  | 'provider-cannot-buy'
  | 'group-is-manual'
  | 'no-concession'
  | 'over-concession'
  | 'unpriced-purchase'
  | 'outside-the-network'
  | 'purchase-in-flight'
  | 'cluster-not-ready';

export interface ActuationFacts {
  canProvision: boolean;
  provision: ProvisionMode;
  concession: SpendingConcession;
  clusterReady: boolean;
  /** A machine already on its way. Nothing may be added while one is in flight. */
  purchaseInFlight: boolean;
  clusterRegion: string | null;
  intent: ScalingIntent;
}

export interface ActuationVerdict {
  act: boolean;
  refusal: ActuationRefusal | null;
  /** The whole of the answer, in the words a decision row carries. */
  because: string;
  /**
   * What the answer leaves out, where it leaves something out.
   *
   * A fleet with unpriced nodes commits more than the figure says, so clearing
   * the ceiling is never proof of anything — only failing it is. Said out loud
   * rather than implied, on exactly the decisions that spend money.
   */
  caveat: string | null;
}

const no = (refusal: ActuationRefusal, because: string): ActuationVerdict => ({
  act: false,
  refusal,
  because,
  caveat: null,
});

/** What a shape costs a month at the price it was chosen with. */
export function monthlyOf(hourlyEur: number | null): number | null {
  return hourlyEur === null ? null : hourlyEur * MONTH_HOURS;
}

/**
 * The only gate between deciding and spending.
 *
 * Two keys, and both have to turn: the group says it may act at all, and the
 * installation says how much it may commit. Either alone leaves a surface where
 * one edit — to a row anybody with write access can change — is the whole
 * distance between a plan and a bill.
 */
export function mayAct(facts: ActuationFacts): ActuationVerdict {
  const { intent } = facts;

  if (!facts.canProvision) {
    // A removal is refused here too, and for a different reason than a
    // purchase. Flui *can* detach a machine the operator brought — but it
    // cannot bring it back, and giving back a node that saves nobody a bill and
    // needs a person to re-attach is a trade nothing should make on its own.
    return no(
      'provider-cannot-buy',
      intent.kind === 'remove'
        ? "Flui cannot put a machine back on this provider, and these are the operator's own machines — removing one saves no bill and leaves a node only a person can re-attach. It is named instead."
        : 'Flui cannot create a server on this provider, so the decision is the whole of what happens here.',
    );
  }

  if (facts.provision !== 'automatic') {
    return no(
      'group-is-manual',
      'This group is set to decide and not to act. Set it to buy automatically for anything here to reach a provider.',
    );
  }

  if (!facts.concession.granted) {
    return no('no-concession', facts.concession.says);
  }

  if (facts.purchaseInFlight) {
    return no(
      'purchase-in-flight',
      intent.kind === 'remove'
        ? 'A machine is on its way to this cluster, so the fleet is about to be a different size. Nothing is given back until it has joined or failed — a count that is about to change is not a count to act on.'
        : 'A machine is already on its way to this cluster. Nothing else is bought until it has joined or failed — a pod stays unplaceable for the whole of a provisioning, and a loop that did not wait would buy one node a minute for it.',
    );
  }

  if (!facts.clusterReady) {
    return no(
      'cluster-not-ready',
      'The cluster is not in a state where a node can be attached to it.',
    );
  }

  if (intent.kind === 'remove') {
    return {
      act: true,
      refusal: null,
      because: 'The fleet is above its target and the node can be emptied.',
      caveat: null,
    };
  }

  // Regions are the cluster's private network, not a preference: a machine
  // bought elsewhere has no way in. The ladder may still name one, because on a
  // provider Flui cannot buy from a person can go and do exactly that.
  if (
    intent.region &&
    facts.clusterRegion &&
    intent.region !== facts.clusterRegion
  ) {
    return no(
      'outside-the-network',
      `The shape that won is in ${intent.region} and this cluster's private network is in ${facts.clusterRegion}. A machine bought there could not join, so buying it is left to a person who can also arrange the network.`,
    );
  }

  const monthly = monthlyOf(intent.hourlyEur);
  if (monthly === null) {
    return no(
      'unpriced-purchase',
      'The shape that won carries no published price, and a spending grant cannot be honoured against an unknown amount. It is named in the alarm instead.',
    );
  }

  const ceiling = facts.concession.monthlyEur ?? 0;
  const projected = intent.fleetMonthlyEur + monthly;
  if (projected > ceiling) {
    return no(
      'over-concession',
      `Buying it would commit about €${roundEur(projected)} a month against the €${ceiling} this installation granted. ${facts.concession.says}`,
    );
  }

  return {
    act: true,
    refusal: null,
    because: `About €${roundEur(projected)} a month against the €${ceiling} granted.`,
    caveat: intent.unpricedNodes
      ? `That figure is a floor: ${intent.unpricedNodes} node(s) in this fleet carry no price and add nothing to it, so clearing the ceiling is not proof of staying under it.`
      : null,
  };
}
