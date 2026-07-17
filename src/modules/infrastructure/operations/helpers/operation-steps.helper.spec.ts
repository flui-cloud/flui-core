import {
  calculateOperationProgress,
  estimateCreateDurationSeconds,
  getOperationSteps,
} from './operation-steps.helper';
import { OperationType } from '../../servers/entities/infrastructure-operations.entity';

describe('getOperationSteps — CREATE_CLUSTER weights', () => {
  const weights = (workerCount: number) =>
    getOperationSteps(OperationType.CREATE_CLUSTER, { workerCount }).map(
      (s) => s.weight,
    );

  it.each([0, 1, 3])('sums to 100 with %i workers', (workerCount) => {
    expect(weights(workerCount).reduce((a, b) => a + b, 0)).toBe(100);
  });

  // The bar is driven by these, so a step must be weighted by what it costs.
  // createMasterNode owns the whole bootstrap; the kubeconfig step that follows
  // only marks work already done, and used to carry 30% for ~25ms of it.
  it('gives the master step the bulk and the kubeconfig step a formality', () => {
    const steps = getOperationSteps(OperationType.CREATE_CLUSTER, {
      workerCount: 0,
    });
    const master = steps.find((s) => s.description.includes('master'))!;
    const kubeconfig = steps.find((s) => s.description.includes('kubeconfig'))!;
    expect(master.weight).toBeGreaterThanOrEqual(70);
    expect(kubeconfig.weight).toBeLessThanOrEqual(10);
  });

  it('hands a large share to workers once there are any', () => {
    const steps = getOperationSteps(OperationType.CREATE_CLUSTER, {
      workerCount: 2,
    });
    const workers = steps.find((s) => s.description.includes('worker'))!;
    expect(workers.weight).toBeGreaterThanOrEqual(40);
  });
});

describe('calculateOperationProgress — single-node create', () => {
  const at = (stepIndex: number, stepProgress: number) =>
    calculateOperationProgress(
      OperationType.CREATE_CLUSTER,
      stepIndex,
      stepProgress,
      {
        workerCount: 0,
      },
    );

  // The master step is where the ~148s goes, so the bar has to move across it
  // rather than sit at its floor and jump. Half of it is roughly mid-bar.
  it('advances through the master step instead of jumping', () => {
    expect(at(1, 0)).toBe(5);
    expect(at(1, 50)).toBe(45);
    expect(at(1, 100)).toBe(85);
  });

  it('reaches 100 at the end of the last step', () => {
    expect(at(3, 100)).toBe(100);
  });
});

describe('estimateCreateDurationSeconds', () => {
  // Measured: 148s for a single-node create on Hetzner hel1.
  it('covers a measured single-node create with room to spare', () => {
    expect(estimateCreateDurationSeconds(0)).toBeGreaterThan(148);
    expect(estimateCreateDurationSeconds(0)).toBeLessThan(400);
  });

  it('charges per batch of two, not per worker', () => {
    expect(estimateCreateDurationSeconds(2)).toBe(
      estimateCreateDurationSeconds(1),
    );
    expect(estimateCreateDurationSeconds(3)).toBeGreaterThan(
      estimateCreateDurationSeconds(2),
    );
  });

  it('grows with the cluster', () => {
    expect(estimateCreateDurationSeconds(4)).toBeGreaterThan(
      estimateCreateDurationSeconds(0),
    );
  });
});
