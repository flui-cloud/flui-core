import type { SandboxStandInRule } from './sandbox-stand-in';
import { exampleClusterBilling } from './sandbox-world-billing';
import {
  exampleClusterSnapshots,
  exampleClusterStorage,
  exampleClusterVariableSet,
  exampleClusterVariableSets,
  exampleOrphanedClaims,
} from './sandbox-world-cluster';
import { CLUSTER_ID } from './sandbox-world-core';
import { exampleClusterFirewall } from './sandbox-world';
import {
  exampleScalingCatalogue,
  exampleScalingGroup,
  exampleScalingPreview,
  exampleScalingRow,
  exampleScalingRows,
} from './sandbox-world-scaling';
import {
  exampleClusterScalingDecisions,
  exampleScalingDecisions,
} from './sandbox-world-scaling-decisions';
import {
  exampleClusterNodes,
  exampleFleetHistory,
} from './sandbox-world-scaling-fleet';

/**
 * The stand-ins behind the tabs of a cluster page and the Scaling section,
 * kept apart from the list in `sandbox-stand-in.ts` only for length: the same
 * rules hold, and the list there includes these.
 */
export const SANDBOX_CLUSTER_STAND_INS: SandboxStandInRule[] = [
  // The machine-room tabs of a cluster page (see `sandbox-world-cluster.ts`).
  {
    verbs: ['GET'],
    pattern: '/infrastructure/clusters/:id/storage',
    build: exampleClusterStorage,
  },
  {
    verbs: ['GET'],
    pattern: '/infrastructure/clusters/:id/storage/orphaned-claims',
    build: exampleOrphanedClaims,
  },
  {
    verbs: ['GET'],
    pattern: '/clusters/:clusterId/snapshots',
    build: exampleClusterSnapshots,
  },
  {
    verbs: ['GET'],
    pattern: '/firewalls/cluster/:clusterId',
    build: exampleClusterFirewall,
  },
  {
    verbs: ['GET'],
    pattern: '/variables/clusters/:clusterId/namespaces/:namespace',
    build: exampleClusterVariableSets,
  },
  {
    verbs: ['GET'],
    pattern: '/variables/clusters/:clusterId/namespaces/:namespace/:name',
    build: exampleClusterVariableSet,
  },
  {
    verbs: ['GET'],
    pattern: '/infrastructure/clusters/:id/billing',
    build: exampleClusterBilling,
  },

  // Scaling, on the example cluster. The Scaling tab of the guest's own cluster
  // shows the same group under the id it asked with; the group's page reads the
  // example cluster's machines and fleet history by the example cluster's id
  // (see `assertOwnCluster` in the fence guard).
  {
    verbs: ['GET'],
    pattern: '/infrastructure/scaling',
    build: exampleScalingRows,
  },
  {
    verbs: ['GET'],
    pattern: '/infrastructure/clusters/:clusterId/scaling',
    build: exampleScalingRow,
  },
  {
    verbs: ['GET'],
    pattern: '/infrastructure/clusters/:clusterId/scaling-decisions',
    build: exampleClusterScalingDecisions,
  },
  {
    verbs: ['GET'],
    pattern: '/infrastructure/scaling-groups/:id',
    build: exampleScalingGroup,
  },
  {
    verbs: ['GET'],
    pattern: '/infrastructure/scaling-groups/:id/preview',
    build: exampleScalingPreview,
  },
  {
    verbs: ['GET'],
    pattern: '/infrastructure/scaling-groups/:id/decisions',
    build: exampleScalingDecisions,
  },
  {
    verbs: ['GET'],
    pattern: '/infrastructure/scaling-groups/:id/catalogue',
    build: exampleScalingCatalogue,
  },
  {
    verbs: ['GET'],
    pattern: '/infrastructure/clusters/:id/fleet/history',
    build: exampleFleetHistory,
  },
  {
    verbs: ['GET'],
    pattern: '/infrastructure/clusters/:id/nodes',
    onlyFor: { id: CLUSTER_ID },
    build: exampleClusterNodes,
  },
];
