import { nodeEventText } from './node-events.core';

describe('nodeEventText', () => {
  it('names the node, the machine and how long it took to join', () => {
    expect(
      nodeEventText({
        event: 'node-joined',
        node: 'worker-3',
        shape: 'cx23',
        region: 'fsn1',
        minutes: 4,
      }),
    ).toEqual({
      saw: 'worker-3 (cx23 in fsn1) is ready.',
      did: 'worker-3 (cx23 in fsn1) joined the cluster after 4 min.',
      why: 'The group asked for it; the order completed.',
    });
  });

  it('says who ordered by hand', () => {
    const t = nodeEventText({
      event: 'node-ordered',
      shape: 'cx33',
      region: 'nbg1',
      by: 'Dawit',
    });
    expect(t.saw).toBe('Dawit asked for a machine.');
    expect(t.did).toBe('Ordered a cx33 in nbg1.');
  });

  it('carries the provider error on a failed purchase', () => {
    expect(
      nodeEventText({
        event: 'purchase-failed',
        shape: 'cx23',
        region: 'hel1',
        error: 'resource_unavailable',
      }).why,
    ).toBe('resource_unavailable');
  });

  it('confirms the deletion at the provider, not only the decision', () => {
    expect(
      nodeEventText({
        event: 'node-removed',
        node: 'worker-2',
        shape: 'cx23',
        region: 'fsn1',
      }).did,
    ).toBe('worker-2 (cx23 in fsn1) was deleted at the provider.');
  });
});
