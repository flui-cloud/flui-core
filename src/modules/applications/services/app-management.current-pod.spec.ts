jest.mock('@kubernetes/client-node', () => ({}));

import { isCurrentPod } from './app-management.service';

describe('isCurrentPod', () => {
  it('keeps running and starting pods, and drops finished or leaving ones', () => {
    const pod = (phase: string, leaving = false) =>
      ({
        metadata: leaving ? { deletionTimestamp: new Date() } : {},
        status: { phase },
      }) as never;
    expect(isCurrentPod(pod('Running'))).toBe(true);
    expect(isCurrentPod(pod('Pending'))).toBe(true);
    expect(isCurrentPod(pod('Failed'))).toBe(false);
    expect(isCurrentPod(pod('Succeeded'))).toBe(false);
    expect(isCurrentPod(pod('Unknown'))).toBe(false);
    expect(isCurrentPod(pod('Running', true))).toBe(false);
  });
});
