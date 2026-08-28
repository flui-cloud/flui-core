import { ProvisionMode, ScalingIntent } from '../scaling.core';

/**
 * Why a decision stayed a decision.
 *
 * Named rather than described, because these are the sentences somebody reads
 * when a machine did not appear, and "it did nothing" is the answer that sends
 * them looking in the wrong place.
 *
 * There is deliberately no installation-wide spending grant here. A scaling
 * group is already the deliberate act — nothing autoscales until somebody
 * writes one — and the group carries its own ceilings, in money and in nodes,
 * where a reader can see them. A second ceiling outside the product guarded one
 * path while `POST /clusters` and `addWorkers` bought servers with none, so it
 * was not protecting the installation's wallet; it was adding friction to a
 * third of the ways out of it. What needs consent is acting *without a person*,
 * and that consent is `provision: automatic` on the group.
 */
export type ActuationRefusal =
  | 'provider-cannot-buy'
  | 'group-is-manual'
  | 'unpriced-purchase'
  | 'outside-the-network'
  | 'purchase-in-flight'
  | 'cluster-not-ready';

export interface ActuationFacts {
  canProvision: boolean;
  provision: ProvisionMode;
  clusterReady: boolean;
  /** A machine already on its way. Nothing may be added while one is in flight. */
  purchaseInFlight: boolean;
  clusterRegion: string | null;
  /**
   * The group's own ceiling in money, or null where it set none.
   *
   * Used only to decide whether an unpriced purchase may go ahead: a group that
   * named no ceiling has accepted whatever the shape costs, and one that named
   * a ceiling cannot have it honoured against an unknown amount. The ceiling
   * itself is enforced on the ladder, which knows the fleet and says it better.
   */
  monthlyCap: number | null;
  intent: ScalingIntent;
}

export interface ActuationVerdict {
  act: boolean;
  refusal: ActuationRefusal | null;
  /** The whole of the answer, in the words a decision row carries. */
  because: string;
}

const no = (refusal: ActuationRefusal, because: string): ActuationVerdict => ({
  act: false,
  refusal,
  because,
});

/**
 * The gate between deciding and acting.
 *
 * Not between deciding and *spending*: the money ceiling belongs to the ladder,
 * which refuses a shape the fleet cannot afford before it is ever chosen, and
 * names the nodes carrying no price while it does. What is left here is whether
 * this group may act at all, and whether now is a moment to act in.
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

  if (intent.hourlyEur === null && facts.monthlyCap !== null) {
    return no(
      'unpriced-purchase',
      `The shape that won carries no published price, and this group's ceiling of €${facts.monthlyCap} a month cannot be honoured against an unknown amount. It is named in the alarm instead.`,
    );
  }

  return {
    act: true,
    refusal: null,
    because:
      'This group buys automatically, and the ladder chose within its ceilings.',
  };
}
