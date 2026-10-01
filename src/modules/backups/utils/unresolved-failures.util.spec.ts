import { unresolvedFailures } from './unresolved-failures.util';

const at = (h: number) => new Date(Date.UTC(2026, 9, 1, h));

describe('unresolvedFailures', () => {
  it('forgets a failure the same policy has since run past', () => {
    expect(
      unresolvedFailures([
        { id: '1', policyId: 'p', status: 'failed', createdAt: at(4) },
        { id: '2', policyId: 'p', status: 'completed', createdAt: at(8) },
      ]),
    ).toBe(0);
  });

  it('counts a policy whose newest run failed once, however often it failed', () => {
    expect(
      unresolvedFailures([
        { id: '1', policyId: 'p', status: 'failed', createdAt: at(4) },
        { id: '2', policyId: 'p', status: 'cancelled', createdAt: at(8) },
        { id: '3', policyId: 'q', status: 'completed', createdAt: at(9) },
      ]),
    ).toBe(1);
  });

  it('counts each failed run no policy owns', () => {
    expect(
      unresolvedFailures([
        { id: '1', policyId: null, status: 'failed', createdAt: at(4) },
        { id: '2', policyId: null, status: 'completed', createdAt: at(5) },
      ]),
    ).toBe(1);
  });
});
