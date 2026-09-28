jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRED_PERMISSION_KEY } from './decorators/require-permission.decorator';
import { REQUIRED_SECTION_KEY } from './decorators/require-section.decorator';
import { IAM_PERMISSION } from './constants/iam-permissions';
import { SECTION } from './constants/iam-sections';
import { AuthzInstallController } from '../authz/controllers/authz-install.controller';
import { ApplicationSnapshotsController } from '../applications/controllers/application-snapshots.controller';
import { HetznerObjectStorageConnectionController } from '../providers/implementations/hetzner/object-storage/hetzner-object-storage-connection.controller';
import { ClusterDnsZoneController } from '../dns/controllers/cluster-dns-zone.controller';
import { SanCertificateController } from '../dns/controllers/san-certificate.controller';
import { ManagementController } from '../management/controllers/management.controller';
import { MailConnectionsController } from '../mail/controllers/mail-connections.controller';
import { ClustersController } from '../infrastructure/clusters/clusters.controller';

const reflector = new Reflector();
const onRoute = (
  key: string,
  controller: Type<unknown>,
  method: string,
): unknown =>
  reflector.getAllAndOverride(key, [
    (controller.prototype as Record<string, () => unknown>)[method],
    controller,
  ]);

describe('guard gaps named by the data-door inventory', () => {
  it('asks cluster:manage in the infrastructure section to install the auth proxy', () => {
    expect(
      onRoute(REQUIRED_PERMISSION_KEY, AuthzInstallController, 'install'),
    ).toBe(IAM_PERMISSION.CLUSTER_MANAGE);
    expect(
      onRoute(REQUIRED_SECTION_KEY, AuthzInstallController, 'install'),
    ).toBe(SECTION.INFRASTRUCTURE);
  });

  it('asks cluster:read to list the snapshots of a whole cluster', () => {
    expect(
      onRoute(
        REQUIRED_PERMISSION_KEY,
        ApplicationSnapshotsController,
        'listSnapshotsForCluster',
      ),
    ).toBe(IAM_PERMISSION.CLUSTER_READ);
  });
});

describe('write routes that carried no gate of their own (F-085..F-089)', () => {
  it.each(['connect', 'status'])(
    'HetznerObjectStorageConnectionController.%s sits in the providers section',
    (method) => {
      expect(
        onRoute(
          REQUIRED_SECTION_KEY,
          HetznerObjectStorageConnectionController,
          method,
        ),
      ).toBe(SECTION.PROVIDERS);
    },
  );

  it('asks cluster:manage to connect Hetzner object storage and cluster:read to read its status', () => {
    expect(
      onRoute(
        REQUIRED_PERMISSION_KEY,
        HetznerObjectStorageConnectionController,
        'connect',
      ),
    ).toBe(IAM_PERMISSION.CLUSTER_MANAGE);
    expect(
      onRoute(
        REQUIRED_PERMISSION_KEY,
        HetznerObjectStorageConnectionController,
        'status',
      ),
    ).toBe(IAM_PERMISSION.CLUSTER_READ);
  });

  it.each([
    [ClusterDnsZoneController, 'configureSystemIngress'],
    [ClusterDnsZoneController, 'syncAuthDomain'],
    [ClusterDnsZoneController, 'syncApiDomain'],
    [ClusterDnsZoneController, 'syncWebDomain'],
    [ClusterDnsZoneController, 'reconcileAssignment'],
    [SanCertificateController, 'create'],
    [SanCertificateController, 'delete'],
  ] as [Type<unknown>, string][])(
    '%p.%s asks cluster:manage in the infrastructure section',
    (controller, method) => {
      expect(onRoute(REQUIRED_SECTION_KEY, controller, method)).toBe(
        SECTION.INFRASTRUCTURE,
      );
      expect(onRoute(REQUIRED_PERMISSION_KEY, controller, method)).toBe(
        IAM_PERMISSION.CLUSTER_MANAGE,
      );
    },
  );

  it.each([
    [ManagementController, 'updateProviderRegions'],
    [ManagementController, 'updateProviderCredentialsExpiry'],
    [MailConnectionsController, 'connect'],
    [MailConnectionsController, 'activate'],
    [MailConnectionsController, 'publishFor'],
    [MailConnectionsController, 'retryWebhook'],
    [ClustersController, 'updateClusterMetadata'],
    [ClustersController, 'updateNodeMetadata'],
  ] as [Type<unknown>, string][])(
    '%p.%s asks cluster:manage',
    (controller, method) => {
      expect(onRoute(REQUIRED_PERMISSION_KEY, controller, method)).toBe(
        IAM_PERMISSION.CLUSTER_MANAGE,
      );
    },
  );
});
