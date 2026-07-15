import {
  OperationType,
  OperationStep,
} from '../../servers/entities/infrastructure-operations.entity';

/**
 * Step configuration interface
 */
export interface OperationStepConfig {
  step: OperationStep;
  description: string;
  weight: number; // Percentage weight (all steps should sum to 100)
}

/**
 * Generate step configuration dynamically based on operation context
 * This allows steps to adapt to different scenarios (e.g., single-node vs multi-node clusters)
 */
export function getOperationSteps(
  operationType: OperationType,
  context?: Record<string, any>,
): OperationStepConfig[] {
  switch (operationType) {
    case OperationType.CREATE_CLUSTER: {
      const workerCount = context?.workerCount || 0;

      if (workerCount === 0) {
        // Single-node cluster (no workers)
        return [
          {
            step: OperationStep.CLUSTER_CREATE_INIT,
            description: 'Initializing cluster creation',
            weight: 5,
          },
          {
            step: OperationStep.CLUSTER_CREATE_MASTER,
            description: 'Creating master node and waiting for K3s',
            weight: 55,
          },
          {
            step: OperationStep.CLUSTER_CREATE_KUBECONFIG,
            description: 'Fetching kubeconfig from master node',
            weight: 30,
          },
          {
            step: OperationStep.CLUSTER_CREATE_FINALIZING,
            description: 'Finalizing cluster setup',
            weight: 10,
          },
        ];
      } else {
        // Multi-node cluster (with workers)
        return [
          {
            step: OperationStep.CLUSTER_CREATE_INIT,
            description: 'Initializing cluster creation',
            weight: 5,
          },
          {
            step: OperationStep.CLUSTER_CREATE_MASTER,
            description: 'Creating master node and waiting for K3s',
            weight: 20,
          },
          {
            step: OperationStep.CLUSTER_CREATE_KUBECONFIG,
            description: 'Fetching kubeconfig from master node',
            weight: 30,
          },
          {
            step: OperationStep.CLUSTER_CREATE_WORKERS,
            description: `Creating ${workerCount} worker node${workerCount > 1 ? 's' : ''}`,
            weight: 35,
          },
          {
            step: OperationStep.CLUSTER_CREATE_FINALIZING,
            description: 'Finalizing cluster setup',
            weight: 10,
          },
        ];
      }
    }

    case OperationType.REINSTALL_CLUSTER: {
      return [
        {
          step: OperationStep.CLUSTER_REINSTALL_INIT,
          description: 'Validating cluster and resolving SSH access',
          weight: 5,
        },
        {
          step: OperationStep.CLUSTER_REINSTALL_PURGE,
          description: 'Wiping k3s and Flui state from the existing server',
          weight: 20,
        },
        {
          step: OperationStep.CLUSTER_REINSTALL_BOOTSTRAP,
          description: 'Re-running the bootstrap install',
          weight: 35,
        },
        {
          step: OperationStep.CLUSTER_REINSTALL_OBSERVABILITY,
          description: 'Waiting for the observability stack to become ready',
          weight: 30,
        },
        {
          step: OperationStep.CLUSTER_REINSTALL_FINALIZE,
          description: 'Fetching kubeconfig and finalizing',
          weight: 10,
        },
      ];
    }

    case OperationType.DELETE_CLUSTER: {
      return [
        {
          step: OperationStep.CLUSTER_DELETE_INIT,
          description: 'Validating cluster deletion',
          weight: 10,
        },
        {
          step: OperationStep.CLUSTER_DELETE_NODES,
          description: 'Queuing node deletions',
          weight: 20,
        },
        {
          step: OperationStep.CLUSTER_DELETE_WAITING,
          description: 'Waiting for all nodes to be deleted',
          weight: 60,
        },
        {
          step: OperationStep.CLUSTER_DELETE_CLEANUP,
          description: 'Cleaning up cluster resources',
          weight: 10,
        },
      ];
    }

    case OperationType.CREATE_SERVER: {
      return [
        {
          step: OperationStep.SERVER_CREATE_INIT,
          description: 'Validating server configuration',
          weight: 10,
        },
        {
          step: OperationStep.SERVER_CREATE_PROVISIONING,
          description: 'Provisioning server on cloud provider',
          weight: 30,
        },
        {
          step: OperationStep.SERVER_CREATE_WAITING,
          description: 'Waiting for server to become ready',
          weight: 50,
        },
        {
          step: OperationStep.SERVER_CREATE_FINALIZING,
          description: 'Finalizing server setup',
          weight: 10,
        },
      ];
    }

    case OperationType.DELETE_SERVER: {
      return [
        {
          step: OperationStep.SERVER_DELETE_INIT,
          description: 'Validating server deletion',
          weight: 10,
        },
        {
          step: OperationStep.SERVER_DELETE_EXECUTING,
          description: 'Deleting server from cloud provider',
          weight: 30,
        },
        {
          step: OperationStep.SERVER_DELETE_WAITING,
          description: 'Waiting for deletion to complete',
          weight: 50,
        },
        {
          step: OperationStep.SERVER_DELETE_CLEANUP,
          description: 'Cleaning up resources',
          weight: 10,
        },
      ];
    }

    case OperationType.STOP_CLUSTER: {
      const nodeCount = context?.nodeCount || 1;
      return [
        {
          step: OperationStep.CLUSTER_STOP_INIT,
          description: 'Initialize cluster stop operation',
          weight: 5,
        },
        {
          step: OperationStep.CLUSTER_STOP_SERVERS,
          description: `Stop ${nodeCount} server${nodeCount > 1 ? 's' : ''}`,
          weight: 85,
        },
        {
          step: OperationStep.CLUSTER_STOP_UPDATE_STATUS,
          description: 'Update cluster status',
          weight: 10,
        },
      ];
    }

    case OperationType.START_CLUSTER: {
      const nodeCount = context?.nodeCount || 1;
      return [
        {
          step: OperationStep.CLUSTER_START_INIT,
          description: 'Initialize cluster start operation',
          weight: 5,
        },
        {
          step: OperationStep.CLUSTER_START_SERVERS,
          description: `Start ${nodeCount} server${nodeCount > 1 ? 's' : ''}`,
          weight: 70,
        },
        {
          step: OperationStep.CLUSTER_START_WAIT_READY,
          description: 'Wait for servers to become ready',
          weight: 15,
        },
        {
          step: OperationStep.CLUSTER_START_UPDATE_STATUS,
          description: 'Update cluster status',
          weight: 10,
        },
      ];
    }

    case OperationType.ATTACH_CLUSTER_TO_VNET: {
      const nodeCount = Math.max(context?.nodeCount || 1, 1);
      return [
        {
          step: OperationStep.CLUSTER_ATTACH_VNET_INIT,
          description: 'Validating VNet/subnet and provider capability',
          weight: 10,
        },
        {
          step: OperationStep.CLUSTER_ATTACH_VNET_NODES,
          description: `Attaching ${nodeCount} node${nodeCount > 1 ? 's' : ''} to VNet`,
          weight: 80,
        },
        {
          step: OperationStep.CLUSTER_ATTACH_VNET_PERSIST,
          description: 'Persisting cluster VNet configuration',
          weight: 10,
        },
      ];
    }

    case OperationType.CLEAR_BUILD_CACHE: {
      return [
        {
          step: OperationStep.BUILD_CACHE_CLEAR_INIT,
          description: 'Validating cache PVC and cluster connectivity',
          weight: 10,
        },
        {
          step: OperationStep.BUILD_CACHE_CLEAR_DELETING,
          description: 'Deleting BuildKit cache PVC',
          weight: 60,
        },
        {
          step: OperationStep.BUILD_CACHE_CLEAR_RECREATING,
          description: 'Recreating empty cache PVC',
          weight: 30,
        },
      ];
    }

    case OperationType.ADD_WORKER: {
      const count = context?.workerCount ?? 1;
      return [
        {
          step: OperationStep.CLUSTER_ADD_WORKER_VALIDATE,
          description: 'Validating cluster and VNet configuration',
          weight: 5,
        },
        {
          step: OperationStep.CLUSTER_ADD_WORKER_PROVISION,
          description: `Provisioning ${count} worker${count > 1 ? 's' : ''}`,
          weight: 80,
        },
        {
          step: OperationStep.CLUSTER_ADD_WORKER_JOIN,
          description: 'Joining K3s cluster and attaching to VNet',
          weight: 10,
        },
        {
          step: OperationStep.CLUSTER_ADD_WORKER_FINALIZE,
          description: 'Finalizing worker addition',
          weight: 5,
        },
      ];
    }

    case OperationType.REMOVE_WORKER: {
      return [
        {
          step: OperationStep.CLUSTER_REMOVE_WORKER_CORDON,
          description: 'Cordoning worker node',
          weight: 5,
        },
        {
          step: OperationStep.CLUSTER_REMOVE_WORKER_DRAIN,
          description: 'Draining workloads from worker',
          weight: 30,
        },
        {
          step: OperationStep.CLUSTER_REMOVE_WORKER_DELETE,
          description: 'Deleting worker server from provider',
          weight: 55,
        },
        {
          step: OperationStep.CLUSTER_REMOVE_WORKER_DELETE_NODE,
          description: 'Removing node from K3s control plane',
          weight: 5,
        },
        {
          step: OperationStep.CLUSTER_REMOVE_WORKER_FINALIZE,
          description: 'Cleanup',
          weight: 5,
        },
      ];
    }

    case OperationType.SCALE_NODE: {
      return [
        {
          step: OperationStep.SCALE_NODE_PRECHECK,
          description: 'Validating target type and node lock',
          weight: 5,
        },
        {
          step: OperationStep.SCALE_NODE_POWER_OFF,
          description: 'Powering off the node',
          weight: 15,
        },
        {
          step: OperationStep.SCALE_NODE_CHANGE_TYPE,
          description: 'Changing server type on provider',
          weight: 30,
        },
        {
          step: OperationStep.SCALE_NODE_POWER_ON,
          description: 'Powering on the node',
          weight: 10,
        },
        {
          step: OperationStep.SCALE_NODE_WAIT_READY,
          description: 'Waiting for k3s node to rejoin Ready',
          weight: 35,
        },
        {
          step: OperationStep.SCALE_NODE_FINALIZE,
          description: 'Finalizing',
          weight: 5,
        },
      ];
    }

    case OperationType.EXPAND_SHARED_VOLUME: {
      return [
        {
          step: OperationStep.EXPAND_VOLUME_PRECHECK,
          description: 'Validating target size',
          weight: 5,
        },
        {
          step: OperationStep.EXPAND_VOLUME_PROVIDER,
          description: 'Resizing volume on provider',
          weight: 60,
        },
        {
          step: OperationStep.EXPAND_VOLUME_RESIZE_FS,
          description: 'Growing filesystem on master',
          weight: 30,
        },
        {
          step: OperationStep.EXPAND_VOLUME_FINALIZE,
          description: 'Finalizing',
          weight: 5,
        },
      ];
    }

    // Placeholder for not-yet-implemented operations
    case OperationType.UPDATE_SERVER:
    case OperationType.START_SERVER:
    case OperationType.STOP_SERVER:
    case OperationType.RESTART_SERVER:
      return [];

    default:
      return [];
  }
}

/**
 * Calculate progress from steps array
 */
function calculateProgressFromSteps(
  steps: OperationStepConfig[],
  currentStepIndex: number,
  currentStepProgress: number,
): number {
  if (!steps || steps.length === 0) return 0;

  let completedProgress = 0;

  // Sum completed steps
  for (let i = 0; i < currentStepIndex && i < steps.length; i++) {
    completedProgress += steps[i].weight;
  }

  // Add current step contribution
  const currentStep = steps[currentStepIndex];
  if (currentStep) {
    completedProgress += (currentStep.weight * currentStepProgress) / 100;
  }

  return Math.min(100, Math.round(completedProgress));
}

/**
 * Calculate total progress based on step index and current step progress
 */
export function calculateOperationProgress(
  operationType: OperationType,
  currentStepIndex: number,
  currentStepProgress: number = 0,
  context?: Record<string, any>,
): number {
  const steps = getOperationSteps(operationType, context);
  return calculateProgressFromSteps(
    steps,
    currentStepIndex,
    currentStepProgress,
  );
}

/**
 * Calculate progress using saved operation steps from metadata
 */
export function calculateOperationProgressFromSaved(
  savedSteps: OperationStepConfig[],
  currentStepIndex: number,
  currentStepProgress: number = 0,
): number {
  return calculateProgressFromSteps(
    savedSteps,
    currentStepIndex,
    currentStepProgress,
  );
}

/**
 * Get step configuration for an operation
 */
export function getStepConfig(
  operationType: OperationType,
  stepIndex: number,
  context?: Record<string, any>,
): OperationStepConfig | undefined {
  const steps = getOperationSteps(operationType, context);
  return steps?.[stepIndex];
}

/**
 * Get step configuration from saved metadata
 */
export function getStepConfigFromSaved(
  savedSteps: OperationStepConfig[],
  stepIndex: number,
): OperationStepConfig | undefined {
  return savedSteps?.[stepIndex];
}

/**
 * Get total number of steps for an operation
 */
export function getTotalSteps(
  operationType: OperationType,
  context?: Record<string, any>,
): number {
  return getOperationSteps(operationType, context)?.length || 0;
}
