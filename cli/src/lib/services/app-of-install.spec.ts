import { appOfInstall } from './cli-app.service';

const apps = [
  { name: 'scaling-probe', slug: 'scaling-probe-4d3c28-1o7yp5' },
  { name: 'immich-server', slug: 'immich-a1b2c3-srv111' },
  { name: 'immich-db', slug: 'immich-a1b2c3-db2222' },
];

describe('an install slug names its app', () => {
  it('finds the one application of an install by the slug the deploy printed', () => {
    expect(appOfInstall(apps, 'scaling-probe-4d3c28').slug).toBe(
      'scaling-probe-4d3c28-1o7yp5',
    );
  });

  it('names the choice when the install has several', () => {
    expect(() => appOfInstall(apps, 'immich-a1b2c3')).toThrow(
      'name one of them: immich-a1b2c3-srv111, immich-a1b2c3-db2222',
    );
  });

  it('still says not found for a name that matches nothing', () => {
    expect(() => appOfInstall(apps, 'nope')).toThrow(
      'App "nope" not found in cluster.',
    );
  });
});
