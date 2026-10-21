// Pulled in transitively and ship ESM that jest won't parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('@octokit/rest', () => ({}));
jest.mock('@octokit/auth-app', () => ({}));

import {
  ApplicationDeployProcessor,
  withQueuedImage,
} from './application-deploy.processor';
import { ApplicationStatus } from '../enums/application-status.enum';
import { OperationType } from '../../infrastructure/servers/entities/infrastructure-operations.entity';

/**
 * The platform's own apps are rolled by patching the image, not by rendering
 * manifests — and that path is where the status was left behind: every update
 * of Flui itself read "updating" for good while the rollout had finished.
 */
describe("updating one of the platform's own apps", () => {
  it('leaves the app running once the rollout has finished', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const operationUpdate = jest.fn().mockResolvedValue(undefined);
    const processor = Object.create(
      ApplicationDeployProcessor.prototype,
    ) as ApplicationDeployProcessor;
    Object.assign(processor, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      applicationsRepository: { update },
      appRevisionsRepository: {
        getNextRevisionNumber: jest.fn().mockResolvedValue(30),
        createAuditEvent: jest.fn().mockResolvedValue({ id: 'rev-30' }),
      },
      kubernetesService: {
        patchDeploymentContainerImage: jest.fn().mockResolvedValue(undefined),
        waitForReady: jest.fn().mockResolvedValue(undefined),
      },
      deployConfig: { getReadinessTimeoutMs: () => 1000 },
      eventsGateway: {
        emitOperationProgress: jest.fn(),
        emitOperationCompleted: jest.fn(),
      },
      updateOperation: jest.fn().mockResolvedValue(undefined),
      operationRepository: {
        findOne: jest.fn().mockResolvedValue({ id: 'op-1', metadata: {} }),
        save: operationUpdate,
      },
    });

    await (
      processor as unknown as {
        handleSystemAppImagePatch: (...args: unknown[]) => Promise<void>;
      }
    ).handleSystemAppImagePatch(
      {
        id: 'app-api',
        name: 'Flui API',
        slug: 'flui-api',
        labels: { app: 'flui-api' },
        k8sNamespace: 'flui-system',
        imageRef: 'ghcr.io/flui-cloud/core:abc1234',
      },
      'kubeconfig',
      'op-1',
      OperationType.DEPLOY_APPLICATION,
      'update',
      undefined,
      undefined,
      Date.now(),
    );

    expect(update).toHaveBeenCalledWith(
      'app-api',
      expect.objectContaining({
        status: ApplicationStatus.RUNNING,
        observedImageRef: 'ghcr.io/flui-cloud/core:abc1234',
      }),
    );
    expect(operationUpdate).toHaveBeenCalledWith({
      id: 'op-1',
      metadata: { rolledImageRef: 'ghcr.io/flui-cloud/core:abc1234' },
    });
  });
});

describe("a retried update of one of the platform's own apps", () => {
  const row = { imageRef: 'ghcr.io/flui-cloud/core:0.14.0-rc.3' };

  it('rolls out the image it was queued for, not the one a restart wrote back', () => {
    expect(
      withQueuedImage(row, 'update', 'ghcr.io/flui-cloud/core:0.14.0-rc.5')
        .imageRef,
    ).toBe('ghcr.io/flui-cloud/core:0.14.0-rc.5');
  });

  it('leaves a rollback to the revision it restores', () => {
    expect(
      withQueuedImage(row, 'rollback', 'ghcr.io/flui-cloud/core:0.14.0-rc.5'),
    ).toBe(row);
  });

  it('keeps the row when the job carries no image', () => {
    expect(withQueuedImage(row, 'update', undefined)).toBe(row);
  });
});
