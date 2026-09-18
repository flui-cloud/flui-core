jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { Reflector } from '@nestjs/core';
import { REQUIRED_SECTION_KEY } from './decorators/require-section.decorator';
import { REQUIRED_PERMISSION_KEY } from './decorators/require-permission.decorator';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { SECTION } from './constants/iam-sections';
import { IAM_PERMISSION } from './constants/iam-permissions';
import { VariablesController } from '../applications/controllers/variables.controller';
import { ClusterGatewayController } from '../applications/controllers/gateway.controller';
import { ServerMetricsController } from '../observability/controllers/server-metrics.controller';
import { ClusterHealthController } from '../observability/controllers/cluster-health.controller';
import { DnsZoneController } from '../dns/controllers/dns-zone.controller';

/**
 * F-003, F-009, F-010, F-013 and F-023 of the September 2026 register, and the
 * shape of the defect they share.
 *
 * `PermissionsGuard` and `SectionAccessGuard` are pass-through on a route that
 * carries neither decorator, so a cluster-scoped route with no gate answers to
 * every authenticated principal on the installation — which is how a zero-grant
 * member read the platform's own configuration and wrote into another tenant's
 * namespace. Every route below is asserted, not only the ones that were found
 * open, so that a new sibling cannot be added without a decision about it.
 */

const reflector = new Reflector();

const gateOn = (controller: object, method: string) => {
  const handler = (controller as Record<string, unknown>)[method];
  // Asserted, because these controllers carry class-level decorators: a handler
  // that has been renamed away would otherwise inherit the class metadata and
  // let this whole file pass while testing nothing.
  if (typeof handler !== 'function') {
    throw new Error(
      `${controller.constructor.name} has no handler named ${method}`,
    );
  }
  return {
    section: reflector.getAllAndOverride<string>(REQUIRED_SECTION_KEY, [
      handler as never,
      controller.constructor as never,
    ]),
    permission: reflector.getAllAndOverride<string>(REQUIRED_PERMISSION_KEY, [
      handler as never,
      controller.constructor as never,
    ]),
    isPublic: reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      handler as never,
      controller.constructor as never,
    ]),
  };
};

describe('routes that answer for a whole cluster', () => {
  describe('variable sets (F-003)', () => {
    const proto = VariablesController.prototype;

    it.each(['listClusterVariables', 'getClusterVariables'])(
      '%s is gated on the Clusters section and cluster:read',
      (method) => {
        expect(gateOn(proto, method)).toMatchObject({
          section: SECTION.CLUSTERS,
          permission: IAM_PERMISSION.CLUSTER_READ,
        });
      },
    );

    it('upsertClusterVariables asks for infrastructure management', () => {
      // A full replace of a ConfigMap any workload or platform component reads.
      expect(gateOn(proto, 'upsertClusterVariables')).toMatchObject({
        section: SECTION.INFRASTRUCTURE,
        permission: IAM_PERMISSION.CLUSTER_MANAGE,
      });
    });

    it.each(['getAppVariables', 'upsertAppVariables'])(
      '%s stays resource-aware rather than section-gated',
      (method) => {
        // The app-scoped half is guarded by AppAccessGuard, and must not acquire
        // a section gate: that would take it away from every scoped operator.
        expect(gateOn(proto, method).section).toBeUndefined();
      },
    );
  });

  describe('gateway routes (F-009)', () => {
    it('the cluster-wide listing is gated on app:read and scoped in the service', () => {
      expect(
        gateOn(ClusterGatewayController.prototype, 'listRoutes'),
      ).toMatchObject({ permission: IAM_PERMISSION.APP_READ });
    });
  });

  describe('node metrics, health and logs (F-010)', () => {
    it.each([
      [ServerMetricsController, 'getClusterMetrics'],
      [ServerMetricsController, 'getClusterMetricsHistory'],
      [ServerMetricsController, 'getClusterLogs'],
      [ServerMetricsController, 'getClusterErrorLogs'],
      [ClusterHealthController, 'getClusterHealth'],
      [ClusterHealthController, 'getClusterHealthHistory'],
    ])('%p.%s is gated', (controller, method) => {
      expect(
        gateOn((controller as { prototype: object }).prototype, method),
      ).toMatchObject({
        section: SECTION.CLUSTERS,
        permission: IAM_PERMISSION.CLUSTER_READ,
      });
    });
  });

  describe('the DNS zone registry (F-013, F-023)', () => {
    const proto = DnsZoneController.prototype;

    it('growing the registry asks for infrastructure management', () => {
      expect(gateOn(proto, 'createZone')).toMatchObject({
        section: SECTION.INFRASTRUCTURE,
        permission: IAM_PERMISSION.CLUSTER_MANAGE,
      });
    });

    it.each(['listZones', 'getZone'])(
      'reading the registry (%s) asks only for the Clusters section',
      (method) => {
        // Deliberately lower than the write: the cluster DNS tab and
        // `flui dns zone list` belong to people who operate clusters without
        // administering the infrastructure, and the response carries no secret.
        expect(gateOn(proto, method)).toMatchObject({
          section: SECTION.CLUSTERS,
          permission: IAM_PERMISSION.CLUSTER_READ,
        });
      },
    );

    it('querying the provider account asks for infrastructure management', () => {
      expect(gateOn(proto, 'listProviderZones')).toMatchObject({
        section: SECTION.INFRASTRUCTURE,
        permission: IAM_PERMISSION.CLUSTER_MANAGE,
      });
    });

    it('the resolution check is no longer public', () => {
      const gate = gateOn(proto, 'verifyDns');
      expect(gate.isPublic).toBeFalsy();
      // And deliberately carries no section: the endpoint form that calls it
      // lives in the application DNS tab, which a scoped operator reaches.
      expect(gate.section).toBeUndefined();
    });

    it('deleting a zone keeps the gate it already had', () => {
      expect(gateOn(proto, 'deleteZone')).toMatchObject({
        section: SECTION.INFRASTRUCTURE,
        permission: IAM_PERMISSION.CLUSTER_MANAGE,
      });
    });
  });
});
