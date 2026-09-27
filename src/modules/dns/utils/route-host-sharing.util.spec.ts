jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { mayShareHost, normalizeRoutePath } from './route-host-sharing.util';
import { AppEndpointService } from '../services/app-endpoint.service';

describe('several routes on one host', () => {
  it('normalises paths the way the gateway compiles them', () => {
    expect(normalizeRoutePath(undefined)).toBe('/');
    expect(normalizeRoutePath('api/')).toBe('/api');
    expect(normalizeRoutePath('/')).toBe('/');
  });

  it('shares a host inside one project, or between one owner’s loose apps', () => {
    expect(mayShareHost({ projectId: 'p' }, { projectId: 'p' })).toBe(true);
    expect(mayShareHost({ projectId: 'p' }, { projectId: 'q' })).toBe(false);
    expect(mayShareHost({ projectId: 'p' }, { userId: 'u' })).toBe(false);
    expect(mayShareHost({ userId: 'u' }, { userId: 'u' })).toBe(true);
    expect(mayShareHost({ userId: 'u' }, { userId: 'v' })).toBe(false);
  });

  const check = (siblings: any[], app: any, path: string) =>
    (AppEndpointService.prototype as any).assertHostShareable.call(
      null,
      siblings,
      app,
      'shop.example.com',
      path,
    );
  const web = {
    routePath: '/',
    application: { name: 'web', projectId: 'p' },
  };

  it('adds a second path for the same project', () => {
    expect(() => check([web], { projectId: 'p' }, '/api')).not.toThrow();
  });

  it('refuses the same path, naming who has it', () => {
    expect(() => check([web], { projectId: 'p' }, '/')).toThrow(
      'already routes to web',
    );
  });

  it('refuses a host another project publishes', () => {
    expect(() => check([web], { projectId: 'q' }, '/api')).toThrow(
      'another project',
    );
  });
});
