import { droppedAutoscalers } from './dropped-autoscaler.util';

describe('droppedAutoscalers', () => {
  const app = { slug: 'web', k8sNamespace: 'ns' };

  it('names every autoscaler to remove once the deploy renders none', () => {
    expect(droppedAutoscalers(app, [{ kind: 'Deployment' }])).toEqual([
      { kind: 'HorizontalPodAutoscaler', name: 'web-hpa', namespace: 'ns' },
      { kind: 'ScaledObject', name: 'web-queue', namespace: 'ns' },
    ]);
  });

  it('keeps the one the deploy still renders and removes the other kind', () => {
    expect(
      droppedAutoscalers(app, [
        { kind: 'Deployment' },
        { kind: 'HorizontalPodAutoscaler' },
      ]),
    ).toEqual([{ kind: 'ScaledObject', name: 'web-queue', namespace: 'ns' }]);
    expect(
      droppedAutoscalers(app, [
        { kind: 'Deployment' },
        { kind: 'ScaledObject' },
      ]),
    ).toEqual([
      { kind: 'HorizontalPodAutoscaler', name: 'web-hpa', namespace: 'ns' },
    ]);
  });
});
