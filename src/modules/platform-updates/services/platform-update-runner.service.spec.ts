jest.mock('@kubernetes/client-node', () => ({}));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { RELEASE } from '../../../config/release.config';
import { PlatformUpdateRunnerService } from './platform-update-runner.service';
import {
  OperationStatus,
  PlatformUpdateOperationMetadata,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { PlatformUpdateStatusDto } from '../dto/platform-update.dto';

const TARGET = '99.0.0';

function status(
  over: Partial<PlatformUpdateStatusDto> = {},
): PlatformUpdateStatusDto {
  return {
    installedVersion: RELEASE.version,
    availableVersion: TARGET,
    updateAvailable: true,
    applicable: true,
    requiredCliVersion: TARGET,
    publishedAt: '2026-09-02T09:00:00.000Z',
    notes: [],
    migrations: 2,
    components: [
      {
        key: 'fluiWeb',
        name: 'Flui Web',
        role: 'Dashboard',
        deploymentName: 'flui-web',
        installed: true,
        observed: true,
        installedIsRelease: true,
        installedVersion: '0.13.0-rc.1',
        targetVersion: TARGET,
        changed: true,
        restartsControlPlane: false,
      },
      {
        key: 'fluiAuthz',
        name: 'Flui Authz',
        role: 'Authorization service',
        deploymentName: 'flui-authz',
        installed: true,
        observed: true,
        installedIsRelease: true,
        installedVersion: '0.6.0',
        targetVersion: '0.6.0',
        changed: false,
        restartsControlPlane: false,
      },
      {
        key: 'fluiApi',
        name: 'Flui API',
        role: 'Control plane API',
        deploymentName: 'flui-api',
        installed: true,
        observed: true,
        installedIsRelease: true,
        installedVersion: RELEASE.version,
        targetVersion: TARGET,
        changed: true,
        restartsControlPlane: true,
      },
    ],
    advisories: [],
    checkedAt: new Date().toISOString(),
    checkError: null,
    ...over,
  };
}

function build(opts: {
  status?: PlatformUpdateStatusDto;
  running?: {
    id: string;
    metadata: Partial<PlatformUpdateOperationMetadata>;
  } | null;
  imageRefs?: Record<string, string>;
  release?: Record<string, unknown>;
  clusterK3s?: Array<string | null>;
}) {
  const saved: any[] = [];
  const queue = { add: jest.fn() };
  let locked = false;
  const operationRepository: any = {
    findOne: jest.fn(async () => saved[0] ?? opts.running ?? null),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((v) => ({ id: 'op-1', ...v })),
    save: jest.fn().mockImplementation((v) => {
      saved.push(v);
      return v;
    }),
  };
  operationRepository.manager = {
    transaction: async (work: (em: unknown) => Promise<unknown>) => {
      const em = {
        query: async () => {
          if (locked) return [{ locked: false }];
          locked = true;
          return [{ locked: true }];
        },
        getRepository: () => operationRepository,
      };
      try {
        return await work(em);
      } finally {
        locked = false;
      }
    },
  };
  const clusters = {
    find: jest.fn(async () =>
      (opts.clusterK3s ?? [RELEASE.k3s.version]).map((k3sVersion, i) => ({
        id: `c${i}`,
        k3sVersion,
      })),
    ),
  };
  const platformUpdates = {
    getStatus: jest.fn().mockResolvedValue(opts.status ?? status()),
    imageRefsFor: jest.fn().mockResolvedValue(
      opts.imageRefs ?? {
        fluiWeb: `ghcr.io/flui-cloud/dashboard:${TARGET}`,
        fluiAuthz: 'ghcr.io/flui-cloud/flui-authz:0.6.0',
        fluiApi: `ghcr.io/flui-cloud/core:${TARGET}`,
      },
    ),
  };
  const releases = opts.release
    ? {
        getManifest: jest.fn().mockResolvedValue({
          manifest: {
            schemaVersion: 2,
            releases: [{ version: TARGET, ...opts.release }],
          },
        }),
      }
    : undefined;
  const service = new PlatformUpdateRunnerService(
    platformUpdates as never,
    operationRepository as never,
    queue as never,
    releases as never,
    clusters as never,
  );
  return { service, queue, operationRepository, saved };
}

describe('PlatformUpdateRunnerService.start', () => {
  it('queues one operation carrying the per-component plan', async () => {
    const { service, queue, saved } = build({});
    const operation = await service.start(TARGET, 'user-1');

    expect(queue.add).toHaveBeenCalledTimes(1);
    const metadata = saved[0].metadata as PlatformUpdateOperationMetadata;
    expect(metadata.targetVersion).toBe(TARGET);
    expect(metadata.fromVersion).toBe(RELEASE.version);
    expect(metadata.migrations).toBe(2);
    expect(metadata.components.map((c) => [c.key, c.status])).toEqual([
      ['fluiWeb', 'pending'],
      ['fluiAuthz', 'skipped'],
      ['fluiApi', 'pending'],
    ]);
    expect(metadata.components.find((c) => c.key === 'fluiApi')?.imageRef).toBe(
      `ghcr.io/flui-cloud/core:${TARGET}`,
    );
    expect(operation.resourceId).toBe(TARGET);
  });

  it('re-checks the manifest instead of trusting the version the caller saw', async () => {
    const { service } = build({
      status: status({ availableVersion: '99.1.0' }),
    });
    await expect(service.start(TARGET)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses when there is nothing to update to', async () => {
    const { service, queue } = build({
      status: status({ updateAvailable: false, availableVersion: null }),
    });
    await expect(service.start(TARGET)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses a release the dashboard cannot apply', async () => {
    const { service, queue } = build({
      status: status({
        applicable: false,
        advisories: [
          {
            level: 'blocker',
            title: 'This release changes the bootstrap manifests',
            detail: 'Install it with the CLI instead.',
          },
        ],
      }),
    });
    await expect(service.start(TARGET)).rejects.toThrow(/bootstrap manifests/);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses when no image could be resolved for a component that must move', async () => {
    const { service } = build({ imageRefs: { fluiAuthz: 'x:0.6.0' } });
    await expect(service.start(TARGET)).rejects.toThrow(/Flui Web, Flui API/);
  });

  it('returns the running operation rather than stacking a second one', async () => {
    const { service, queue } = build({
      running: { id: 'op-running', metadata: { targetVersion: TARGET } },
    });
    const operation = await service.start(TARGET);
    expect(operation.id).toBe('op-running');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses a second update while another release is being applied', async () => {
    const { service } = build({
      running: { id: 'op-running', metadata: { targetVersion: '99.5.0' } },
    });
    await expect(service.start(TARGET)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('the image-only path, kept for the release that ships the phased update', () => {
  it('still applies a release that only moves images, unchanged', async () => {
    const { service, queue } = build({
      release: { k3s: { version: RELEASE.k3s.version } },
    });
    await service.start(TARGET, 'user-1');
    expect(queue.add).toHaveBeenCalledWith(
      'run-platform-update',
      { operationId: 'op-1' },
      { attempts: 1 },
    );
  });

  it('refuses a release that also upgrades K3s or changes manifests, and says how to plan it', async () => {
    const { service, queue } = build({
      release: { k3s: { version: 'v9.0.0+k3s1' }, manifestSets: ['common'] },
    });
    await expect(service.start(TARGET)).rejects.toThrow(/plan/i);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('two updates started at the same moment', () => {
  it('records one operation and refuses the other', async () => {
    const { service, saved } = build({});
    const results = await Promise.allSettled([
      service.start(TARGET, 'u1'),
      service.start('99.0.0', 'u2'),
      service.start(TARGET, 'u3'),
    ]);
    expect(saved).toHaveLength(1);
    expect(
      results.some(
        (r) => r.status === 'rejected' && r.reason instanceof ConflictException,
      ),
    ).toBe(true);
  });
});

describe('the K3s the image-only path compares against', () => {
  it('is what the clusters run, not what this API was built with', async () => {
    const { service, queue } = build({
      release: { k3s: { version: RELEASE.k3s.version } },
      clusterK3s: [RELEASE.k3s.version, 'v1.20.0+k3s1'],
    });
    await expect(service.start(TARGET)).rejects.toThrow(/K3s/);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses a release that changes the bootstrap even without a manifest list', async () => {
    const { service } = build({
      release: {
        k3s: { version: RELEASE.k3s.version },
        requiresBootstrap: true,
      },
    });
    await expect(service.start(TARGET)).rejects.toThrow(/bootstrap/);
  });
});

describe('PlatformUpdateRunnerService.findRunning', () => {
  it('looks only at operations that have not finished', async () => {
    const { service, operationRepository } = build({});
    await service.findRunning();
    const where = operationRepository.findOne.mock.calls[0][0].where;
    expect(where.status._value).toEqual([
      OperationStatus.PENDING,
      OperationStatus.IN_PROGRESS,
    ]);
  });
});
