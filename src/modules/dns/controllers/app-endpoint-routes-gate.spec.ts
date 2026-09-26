jest.mock('@kubernetes/client-node', () => ({}));

import 'reflect-metadata';
import { AppEndpointController } from './app-endpoint.controller';
import { REQUIRED_PERMISSION_KEY } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

const permissionOf = (method: string): string | undefined =>
  Reflect.getMetadata(
    REQUIRED_PERMISSION_KEY,
    AppEndpointController.prototype[method as keyof AppEndpointController],
  );

/**
 * A route with no permission decorator is never consulted by the IAM layer, so
 * every route that moves an application's public name must carry one.
 * `checkFqdn` is the one exception, and says nothing about who owns a name.
 */
describe('the app endpoint routes', () => {
  const routes = Object.getOwnPropertyNames(
    AppEndpointController.prototype,
  ).filter(
    (name) =>
      name !== 'constructor' &&
      Reflect.getMetadata(
        'path',
        AppEndpointController.prototype[name as keyof AppEndpointController],
      ) !== undefined,
  );

  it('are all gated, except the name-availability check', () => {
    const open = routes.filter(
      (name) => name !== 'checkFqdn' && !permissionOf(name),
    );
    expect(open).toEqual([]);
  });

  it.each(['createEndpoint', 'updateEndpoint', 'deleteEndpoint', 'reconcile'])(
    '%s needs app:write',
    (method) => {
      expect(permissionOf(method)).toBe(IAM_PERMISSION.APP_WRITE);
    },
  );
});
