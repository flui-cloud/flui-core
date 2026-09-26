import { droppedAutoscaler } from './dropped-autoscaler.util';

describe('droppedAutoscaler', () => {
  const app = { slug: 'web', k8sNamespace: 'ns' };

  it('names the autoscaler to remove once the deploy stops rendering one', () => {
    expect(droppedAutoscaler(app, [{ kind: 'Deployment' }])).toEqual({
      kind: 'HorizontalPodAutoscaler',
      name: 'web-hpa',
      namespace: 'ns',
    });
  });

  it('keeps it while the deploy still renders it', () => {
    expect(
      droppedAutoscaler(app, [
        { kind: 'Deployment' },
        { kind: 'HorizontalPodAutoscaler' },
      ]),
    ).toBeNull();
  });
});
