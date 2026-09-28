jest.mock('@kubernetes/client-node', () => ({}));

import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { PlatformUpdatesController } from './platform-updates.controller';
import { ManifestRefreshService } from '../services/manifest-refresh.service';
import { PolicyEngine } from '../../iam/interfaces/policy-engine.interface';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

function controllerFor(opts: { published: boolean; mayPreview: boolean }) {
  const manifests = {
    isPublishedRef: jest.fn().mockResolvedValue(opts.published),
    plan: jest.fn().mockResolvedValue({ planId: 'p1' }),
    apply: jest.fn().mockResolvedValue({ planId: 'p1', wrote: [] }),
  } as unknown as ManifestRefreshService;
  const policy = {
    check: jest.fn((_p: unknown, perm: string) =>
      Promise.resolve(
        perm === IAM_PERMISSION.PLATFORM_PREVIEW && opts.mayPreview,
      ),
    ),
  } as unknown as PolicyEngine;
  const controller = new PlatformUpdatesController(
    {} as never,
    {} as never,
    {} as never,
    manifests,
    policy,
  );
  return { controller, manifests, policy };
}

const req = {
  user: { userId: 'u1', email: 'm@example.com', isAdmin: false },
} as unknown as Request;

describe('PlatformUpdatesController manifest ref', () => {
  it('refuses an unreleased ref to someone without platform:preview', async () => {
    const { controller, manifests } = controllerFor({
      published: false,
      mayPreview: false,
    });
    await expect(
      controller.planManifests(req, { ref: 'feature-x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.applyManifests(req, { ref: 'feature-x', planId: 'p1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(manifests.plan).not.toHaveBeenCalled();
    expect(manifests.apply).not.toHaveBeenCalled();
  });

  it('lets platform:preview refresh from an unreleased ref', async () => {
    const { controller, manifests } = controllerFor({
      published: false,
      mayPreview: true,
    });
    await controller.planManifests(req, { ref: 'feature-x' });
    expect(manifests.plan).toHaveBeenCalled();
  });

  it('does not ask for platform:preview on a published release', async () => {
    const { controller, policy } = controllerFor({
      published: true,
      mayPreview: false,
    });
    await controller.applyManifests(req, { ref: 'v0.13.0', planId: 'p1' });
    expect(policy.check).not.toHaveBeenCalled();
  });
});

describe('PlatformUpdatesController.start', () => {
  const operation = {
    id: 'op-1',
    status: 'PENDING',
    metadata: { fromVersion: '1', targetVersion: '2', components: [] },
  };

  function controllerWith() {
    const runner = { start: jest.fn().mockResolvedValue(operation) };
    const upgrades = { apply: jest.fn().mockResolvedValue(operation) };
    const controller = new PlatformUpdatesController(
      {} as never,
      runner as never,
      {} as never,
      {} as never,
      {} as never,
      upgrades as never,
    );
    return { controller, runner, upgrades };
  }

  it('keeps the image-only path when no plan id is given', async () => {
    const { controller, runner, upgrades } = controllerWith();
    const dto = await controller.start(req, { targetVersion: '2' });
    expect(runner.start).toHaveBeenCalledWith('2', 'u1');
    expect(upgrades.apply).not.toHaveBeenCalled();
    expect(dto.schema).toBe(1);
  });

  it('applies the planned update when a plan id is given, carrying the acknowledgement', async () => {
    const { controller, runner, upgrades } = controllerWith();
    await controller.start(req, {
      targetVersion: '2',
      planId: 'p1',
      withoutBackup: true,
      acknowledgement: 'ack',
    });
    expect(runner.start).not.toHaveBeenCalled();
    expect(upgrades.apply).toHaveBeenCalledWith(
      {
        targetVersion: '2',
        planId: 'p1',
        withoutBackup: true,
        acknowledgement: 'ack',
      },
      expect.objectContaining({ userId: 'u1', email: 'm@example.com' }),
    );
  });
});
