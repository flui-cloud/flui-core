import {
  isSandboxAllowed,
  sandboxLevelOf,
} from '../sandbox/constants/sandbox-fence';

/**
 * The tightest case there is, and the one the whole thing is built for: a
 * sandbox guest, connecting an agent on a trial tenancy.
 *
 * If the boundary holds for a guest it holds for anybody, because for anybody
 * else the constraints are a subset — a guest has a derived namespace, a cluster
 * tied to its tenancy, and no read at all on its neighbours.
 *
 * The line that has to be here or the demo dies at the first thing the agent
 * tries to do: **deciding is a write.** The read-only third state of a section
 * does not reach it, so without these rules in the fence's "own" set the guest
 * sees the request and cannot say yes.
 */
describe('the guest can answer their own agent', () => {
  it('may read what the agent is asking for', () => {
    expect(isSandboxAllowed('GET', '/agent/proposals')).toBe(true);
    expect(isSandboxAllowed('GET', '/agent/proposals/:id')).toBe(true);
  });

  it('may say yes — the write that the section level would not have reached', () => {
    expect(isSandboxAllowed('POST', '/agent/proposals/:id/decide')).toBe(true);
    expect(sandboxLevelOf('POST', '/agent/proposals/:id/decide')).toBe('full');
  });

  it('may see, and take back, what it has already allowed', () => {
    expect(isSandboxAllowed('GET', '/agent/concessions')).toBe(true);
    expect(isSandboxAllowed('GET', '/agent/concessions/:id/operations')).toBe(
      true,
    );
    expect(isSandboxAllowed('DELETE', '/agent/concessions/:id')).toBe(true);
  });

  it('gains nothing else from the cycle existing', () => {
    // A concession removes a pause; it never opens a route. Anything the fence
    // did not already allow stays refused, and the guard order is what makes
    // that true rather than this list — the fence runs second, the cycle fifth.
    expect(
      isSandboxAllowed('POST', '/infrastructure/clusters/:id/workers'),
    ).toBe(false);
    expect(isSandboxAllowed('POST', '/agent/concessions')).toBe(false);
    expect(isSandboxAllowed('DELETE', '/agent/proposals/:id')).toBe(false);
  });

  it('still reaches the two routes the trial is built on', () => {
    // The decorated routes themselves. If either of these fell out of the
    // fence, the request would never be raised because the call would be
    // refused two guards earlier.
    expect(isSandboxAllowed('POST', '/clusters/:clusterId/applications')).toBe(
      true,
    );
    expect(isSandboxAllowed('POST', '/applications/:id/deploy')).toBe(true);
  });
});
