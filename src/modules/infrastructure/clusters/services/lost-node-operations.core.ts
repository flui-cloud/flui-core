import { OperationType } from '../../servers/entities/infrastructure-operations.entity';

/**
 * A node purchase or removal still recorded as running while no job in the
 * queue carries it: the API that ran it was stopped under it, or the queue lost
 * it. Left alone it counts as "a machine on its way" for ever, and the scaling
 * group neither buys nor gives back anything again on that cluster.
 */

export const NODE_OPERATIONS = [
  OperationType.ADD_WORKER,
  OperationType.REMOVE_WORKER,
];

export interface LostNodeOperation {
  operationType: OperationType;
  nodeName: string | null;
}

export type Uncordon = 'done' | 'failed' | 'not-attempted';

/**
 * What a person reads on the operation once it is closed. A removal says
 * whether its node is back in service, because a node left cordoned takes no
 * new work and nothing on any screen says why.
 */
export function lostNodeOperationMessage(
  op: LostNodeOperation,
  uncordon: Uncordon,
): string {
  const lost =
    'Nothing was carrying this any more: the job behind it was lost, usually because the API that ran it was stopped.';
  if (op.operationType === OperationType.ADD_WORKER) {
    return `${lost} Check the provider for a server that never joined the cluster before buying again.`;
  }
  const node = op.nodeName ?? 'The node';
  if (uncordon === 'done') {
    return `${lost} ${node} was put back in service and nothing was removed. The scaling group decides again on its next pass.`;
  }
  if (uncordon === 'failed') {
    return `${lost} ${node} could not be put back in service and takes no new work until someone does: flui env uncordon ${op.nodeName ?? '<node>'}.`;
  }
  return `${lost} The removal had already reached the server, so ${node} may be gone at the provider. Check the cluster's nodes.`;
}
