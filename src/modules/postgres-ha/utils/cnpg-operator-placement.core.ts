import { TOPOLOGY_ZONE_LABEL } from '../../providers/core/node-topology';
import { CNPG_DEPLOYMENT, CNPG_NAMESPACE } from '../postgres-ha.constants';

export const CNPG_OPERATOR_REPLICAS = 2;

/**
 * The operator decides every failover. As shipped it runs one copy, and a lost
 * location that held it leaves the database without a primary for as long as
 * the location is away. Two copies in different locations, with the leader
 * election the operator already runs, leave one to act.
 */
export function cnpgOperatorPlacement(): Record<string, unknown> {
  const selector = {
    matchLabels: { 'app.kubernetes.io/name': 'cloudnative-pg' },
  };
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: CNPG_DEPLOYMENT, namespace: CNPG_NAMESPACE },
    spec: {
      replicas: CNPG_OPERATOR_REPLICAS,
      template: {
        spec: {
          affinity: {
            podAntiAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: [
                { labelSelector: selector, topologyKey: TOPOLOGY_ZONE_LABEL },
              ],
            },
          },
          tolerations: [{ operator: 'Exists', effect: 'NoSchedule' }],
        },
      },
    },
  };
}
