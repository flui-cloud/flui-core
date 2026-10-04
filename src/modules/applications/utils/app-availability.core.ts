export type AvailabilityReasonCode =
  | 'single_copy'
  | 'copies_on_one_node'
  | 'single_ingress_node'
  | 'dedicated_placement'
  | 'volume_on_one_node'
  | 'ip_hostname';

export interface AvailabilityReason {
  code: AvailabilityReasonCode;
  message: string;
}

export interface AppAvailability {
  /** Survives the loss of one worker: keeps answering, keeps its data. */
  highlyAvailable: boolean;
  /** Empty when highly available; otherwise every reason it is not, in the order to fix them. */
  reasons: AvailabilityReason[];
}

export interface AvailabilityInput {
  /** Copies the application is meant to run (its fixed count or its scaling minimum). */
  desiredCopies: number;
  /** The node each ready copy runs on now. */
  readyCopyNodes: string[];
  /** Nodes of the cluster that take traffic for its public names. */
  ingressNodeCount: number;
  dedicated: boolean;
  volumes: Array<{ name: string; boundToNode: string | null }>;
  endpoints: Array<{ fqdn: string; ipHostname: boolean }>;
}

/**
 * Whether an application keeps answering when one worker of its cluster is
 * lost. The database and the cluster's master are single points that no
 * application setting changes, so they are not reasons here: this answers what
 * the application itself can do something about.
 */
export function appAvailability(input: AvailabilityInput): AppAvailability {
  const reasons: AvailabilityReason[] = [];

  if (input.desiredCopies < 2) {
    reasons.push({
      code: 'single_copy',
      message:
        'Runs one copy: losing its node stops it. Set deploy.scaling.min to 2 or more.',
    });
  }
  if (input.dedicated) {
    reasons.push({
      code: 'dedicated_placement',
      message:
        'Is placed on one node on purpose, with storage on that node’s own disk.',
    });
  }
  const nodes = new Set(input.readyCopyNodes);
  if (input.desiredCopies >= 2 && !input.dedicated && nodes.size < 2) {
    reasons.push({
      code: 'copies_on_one_node',
      message:
        nodes.size === 1
          ? `Its copies all run on ${[...nodes][0]}: the cluster has no other node with room for one.`
          : 'None of its copies is running right now.',
    });
  }
  for (const volume of input.volumes) {
    if (!volume.boundToNode) continue;
    reasons.push({
      code: 'volume_on_one_node',
      message: `Volume ${volume.name} stays on ${volume.boundToNode}: if that node is lost the application waits for it.`,
    });
  }
  if (input.endpoints.length > 0) {
    for (const endpoint of input.endpoints.filter((e) => e.ipHostname)) {
      reasons.push({
        code: 'ip_hostname',
        message: `${endpoint.fqdn} is a nip.io address, which names one node. Give the application a domain.`,
      });
    }
    if (input.ingressNodeCount < 2) {
      reasons.push({
        code: 'single_ingress_node',
        message:
          'Only one node of the cluster takes traffic for its addresses: add a worker.',
      });
    }
  }

  return { highlyAvailable: reasons.length === 0, reasons };
}
