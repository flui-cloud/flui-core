jest.mock('@kubernetes/client-node', () => ({}));

import { ApplicationReconciliationService } from './application-reconciliation.service';
import { ApplicationResourceStatus } from '../enums/application-resource-status.enum';

describe('replica autoscaler readiness', () => {
  const service = Object.create(ApplicationReconciliationService.prototype) as {
    computeResourceStatus(kind: string, r: unknown): ApplicationResourceStatus;
  };

  const hpa = (ableToScale?: 'True' | 'False') => ({
    status: {
      conditions: ableToScale
        ? [{ type: 'AbleToScale', status: ableToScale }]
        : [],
    },
  });

  it('counts a working autoscaler as ready, so the app is not held degraded', () => {
    expect(
      service.computeResourceStatus('HorizontalPodAutoscaler', hpa('True')),
    ).toBe(ApplicationResourceStatus.READY);
    expect(
      service.computeResourceStatus('HorizontalPodAutoscaler', hpa()),
    ).toBe(ApplicationResourceStatus.READY);
  });

  it('reports one that cannot scale', () => {
    expect(
      service.computeResourceStatus('HorizontalPodAutoscaler', hpa('False')),
    ).toBe(ApplicationResourceStatus.DEGRADED);
  });
});
