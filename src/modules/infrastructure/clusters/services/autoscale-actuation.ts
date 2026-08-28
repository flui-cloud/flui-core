/**
 * What actually happens when this cluster runs out of room. Derived from
 * provider capability and from whether anything is registered to act — never
 * from a provider name, and never written down as a constant.
 */
export enum AutoscaleActuation {
  /** Something is registered to act: a node arrives without being asked. */
  AUTOMATIC = 'automatic',
  /** Flui can create a node here, but only a person's request creates one. */
  NOT_DRIVEN = 'not_driven',
  /** Flui cannot create a node here; it can still name the size to buy and its price. */
  ALERT_ONLY_SIZED = 'alert_only_sized',
  /** Flui cannot create a node here and has no catalogue to name a size from. */
  ALERT_ONLY_UNSIZED = 'alert_only_unsized',
}

export interface AutoscaleActuationFacts {
  provider: string;
  /** `features.nodeProvisioning` — can Flui create a server through this provider's API. */
  nodeProvisioning: boolean;
  /** Whether the provider offers any node size Flui can name and price. */
  hasSizeCatalog: boolean;
  /** Whether anything is registered to add nodes on its own. */
  driven: boolean;
}

export function resolveAutoscaleActuation(
  facts: AutoscaleActuationFacts,
): AutoscaleActuation {
  if (facts.nodeProvisioning) {
    return facts.driven
      ? AutoscaleActuation.AUTOMATIC
      : AutoscaleActuation.NOT_DRIVEN;
  }
  return facts.hasSizeCatalog
    ? AutoscaleActuation.ALERT_ONLY_SIZED
    : AutoscaleActuation.ALERT_ONLY_UNSIZED;
}

/** True where scaling ends in an alert for a person rather than in a new node. */
export function isAlertOnly(actuation: AutoscaleActuation): boolean {
  return (
    actuation === AutoscaleActuation.ALERT_ONLY_SIZED ||
    actuation === AutoscaleActuation.ALERT_ONLY_UNSIZED
  );
}

export function describeAutoscaleActuation(
  actuation: AutoscaleActuation,
  provider: string,
): string {
  switch (actuation) {
    case AutoscaleActuation.AUTOMATIC:
      return (
        `Flui adds a node on ${provider} on its own when the cluster runs out ` +
        `of room, within the cooldown window and up to the node limit.`
      );
    case AutoscaleActuation.NOT_DRIVEN:
      return (
        `Flui can add a node on ${provider}, but nothing adds one on its own: ` +
        `a node appears only when a person asks for one. The thresholds and ` +
        `node limits below describe when a node is needed — they do not create it.`
      );
    case AutoscaleActuation.ALERT_ONLY_SIZED:
      return (
        `Flui cannot create a server on ${provider}, so scaling here is an ` +
        `alert, not an action. When the cluster runs out of room Flui can name ` +
        `the size to buy and what it costs; buying it and attaching it is yours to do.`
      );
    case AutoscaleActuation.ALERT_ONLY_UNSIZED:
      return (
        `Flui cannot create a server on ${provider} and has no size catalogue ` +
        `for it, so scaling here is an alert, not an action. When the cluster ` +
        `runs out of room Flui can say how much CPU and memory the next machine ` +
        `has to hold; you choose it and attach it with \`flui node connect\`.`
      );
  }
}

/**
 * The sentence the capacity gate owes a reader who is about to deploy into a
 * cluster that has no room. `autoscaling_pending` is the case that used to
 * promise a node silently.
 */
export function describeCapacityOutcome(
  actuation: AutoscaleActuation,
  reason: 'insufficient_resources' | 'autoscaling_pending',
): string {
  if (reason === 'insufficient_resources') {
    return (
      'The cluster does not have room for this. Free capacity by removing ' +
      'unused applications, or give the cluster another node.'
    );
  }
  switch (actuation) {
    case AutoscaleActuation.AUTOMATIC:
      return (
        'The cluster does not have room for this right now. Autoscaling is on ' +
        'and a node will be added; the workload stays pending until it joins.'
      );
    case AutoscaleActuation.NOT_DRIVEN:
      return (
        'The cluster does not have room for this. Autoscaling is on, but ' +
        'nothing adds a node on its own — unless someone adds one first, this ' +
        'workload will stay pending indefinitely.'
      );
    case AutoscaleActuation.ALERT_ONLY_SIZED:
    case AutoscaleActuation.ALERT_ONLY_UNSIZED:
      return (
        'The cluster does not have room for this. Autoscaling is on, but Flui ' +
        'cannot create a server on this provider — no node will appear, and ' +
        'this workload will stay pending until you attach one yourself.'
      );
  }
}
