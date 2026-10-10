import { isSandboxAllowed, sandboxLevelOf } from './sandbox-fence';
import { routeMatches } from './sandbox-fence-core';

/** F-105: a rule's `:param` admits a parameter of a route, never a literal route next to it. */
describe('the fence against the route a request reached', () => {
  it('does not take a literal segment for a parameter', () => {
    expect(
      routeMatches(
        '/infrastructure/clusters/:id',
        '/infrastructure/clusters/orphan-volumes',
        true,
      ),
    ).toBe(false);
    expect(
      routeMatches(
        '/infrastructure/clusters/:id',
        '/infrastructure/clusters/:id',
        true,
      ),
    ).toBe(true);
    expect(
      routeMatches('/applications/:id/**', '/applications/:id/logs', true),
    ).toBe(true);
  });

  it.each([
    ['GET', '/applications/manifest/validate'],
    ['POST', '/applications/manifest/validate'],
    ['GET', '/infrastructure/clusters/orphan-volumes'],
    ['GET', '/infrastructure/clusters/name-availability'],
    ['GET', '/catalog-installs/:id'],
  ])('keeps %s %s closed to guests', (verb, route) => {
    expect(isSandboxAllowed(verb, route, true)).toBe(false);
  });

  it('still opens what is the guest’s own, and lists catalog reads by name', () => {
    expect(isSandboxAllowed('GET', '/applications/:id', true)).toBe(true);
    expect(isSandboxAllowed('GET', '/catalog/:slug', true)).toBe(true);
    expect(isSandboxAllowed('GET', '/catalog/building-blocks', true)).toBe(
      true,
    );
    expect(sandboxLevelOf('GET', '/applications/:id', true)).toBe('full');
  });
});
