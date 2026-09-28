import { RELEASE } from '../../../config/release.config';
import { PlatformUpdateResumeService } from './platform-update-resume.service';
import {
  OperationStatus,
  PlatformUpdateOperationMetadata,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  PlatformUpgradeMetadata,
  UpgradePhaseKey,
} from '../interfaces/platform-upgrade.interface';

function operation(over: {
  targetVersion: string;
  awaitingSince?: string;
  awaitingSelfRestart?: boolean;
}) {
  const metadata: PlatformUpdateOperationMetadata = {
    fromVersion: '0.0.1',
    targetVersion: over.targetVersion,
    migrations: 1,
    awaitingSelfRestart: over.awaitingSelfRestart ?? true,
    awaitingSince: over.awaitingSince ?? new Date().toISOString(),
    components: [
      {
        key: 'fluiApi',
        name: 'Flui API',
        fromVersion: '0.0.1',
        targetVersion: over.targetVersion,
        imageRef: 'ghcr.io/flui-cloud/core:x',
        status: 'running',
      },
    ],
  };
  return {
    id: 'op-1',
    status: OperationStatus.IN_PROGRESS,
    createdAt: new Date(),
    metadata,
  } as never;
}

function build(rows: unknown[]) {
  const repo = {
    find: jest.fn().mockResolvedValue(rows),
    save: jest.fn().mockImplementation((v) => v),
  };
  const queue = { add: jest.fn() };
  return {
    service: new PlatformUpdateResumeService(repo as never, queue as never),
    repo,
    queue,
  };
}

const MIN = 60_000;

function phased(over: {
  targetVersion: string;
  awaitingSelfRestart?: boolean;
  running: UpgradePhaseKey;
  deadlineInMs: number;
}) {
  const base = operation({
    targetVersion: over.targetVersion,
    awaitingSelfRestart: over.awaitingSelfRestart ?? false,
    awaitingSince: new Date(Date.now() - 20 * MIN).toISOString(),
  }) as unknown as { metadata: PlatformUpgradeMetadata };
  const order: UpgradePhaseKey[] = [
    'backup',
    'manifests',
    'images',
    'k3s',
    'verify',
  ];
  const at = order.indexOf(over.running);
  base.metadata = {
    ...base.metadata,
    schema: 2,
    planId: 'plan-1',
    bootstrapRef: 'abc',
    k3sVersion: 'v1.36.1+k3s1',
    withoutBackup: false,
    phases: order.map((key, i) => ({
      key,
      title: key,
      status: i < at ? 'done' : i === at ? 'running' : 'pending',
      ...(key === 'backup' ? { backupJobId: 'job-7' } : {}),
      ...(i === at
        ? { deadlineAt: new Date(Date.now() + over.deadlineInMs).toISOString() }
        : {}),
    })),
  };
  return base as never;
}

describe('PlatformUpdateResumeService — phased updates', () => {
  it('continues with K3s and the checks after the restart, instead of completing', async () => {
    const { service, repo, queue } = build([
      phased({
        targetVersion: RELEASE.version,
        awaitingSelfRestart: true,
        running: 'images',
        deadlineInMs: 5 * MIN,
      }),
    ]);
    await service.onApplicationBootstrap();

    const saved = repo.save.mock.calls[0][0];
    expect(saved.status).toBe(OperationStatus.IN_PROGRESS);
    expect(saved.metadata.awaitingSelfRestart).toBe(false);
    expect(
      saved.metadata.phases.find((p: { key: string }) => p.key === 'images')
        .status,
    ).toBe('done');
    expect(saved.metadata.components[0].status).toBe('done');
    expect(queue.add).toHaveBeenCalledWith(
      'run-platform-upgrade',
      { operationId: 'op-1' },
      expect.objectContaining({ attempts: 1 }),
    );
  });

  it('keeps the phase deadline rather than the 15-minute rule while it has time left', async () => {
    const { service, repo } = build([
      phased({
        targetVersion: '99.0.0',
        awaitingSelfRestart: true,
        running: 'images',
        deadlineInMs: 5 * MIN,
      }),
    ]);
    await service.failStalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('fails the phase that overran its deadline, keeping where it stopped and what to do', async () => {
    const { service, repo } = build([
      phased({
        targetVersion: RELEASE.version,
        running: 'k3s',
        deadlineInMs: -MIN,
      }),
    ]);
    await service.failStalled();

    const saved = repo.save.mock.calls[0][0];
    expect(saved.status).toBe(OperationStatus.FAILED);
    expect(saved.metadata.failedPhase).toBe('k3s');
    expect(saved.metadata.guidance).toMatch(/never downgrade/i);
    expect(saved.metadata.guidance).toContain('job-7');
  });

  it('says the API never came back once the images phase overran', async () => {
    const { service, repo } = build([
      phased({
        targetVersion: '99.0.0',
        awaitingSelfRestart: true,
        running: 'images',
        deadlineInMs: -MIN,
      }),
    ]);
    await service.failStalled();
    const saved = repo.save.mock.calls[0][0];
    expect(saved.status).toBe(OperationStatus.FAILED);
    expect(saved.errorMessage).toContain('never came back on 99.0.0');
    expect(saved.metadata.failedPhase).toBe('images');
  });
});

describe('PlatformUpdateResumeService', () => {
  it('closes the parked operation when the new pod is the target version', async () => {
    const { service, repo } = build([
      operation({ targetVersion: RELEASE.version }),
    ]);
    await service.onApplicationBootstrap();

    const saved = repo.save.mock.calls[0][0];
    expect(saved.status).toBe(OperationStatus.COMPLETED);
    expect(saved.progress).toBe(100);
    expect(saved.metadata.awaitingSelfRestart).toBe(false);
    expect(saved.metadata.components[0].status).toBe('done');
  });

  it('leaves it alone when the old pod merely restarted', async () => {
    const { service, repo } = build([operation({ targetVersion: '99.0.0' })]);
    await service.onApplicationBootstrap();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('does not touch an operation that is not awaiting a restart', async () => {
    const { service, repo } = build([
      operation({ targetVersion: RELEASE.version, awaitingSelfRestart: false }),
    ]);
    await service.onApplicationBootstrap();
    await service.failStalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('waits before calling a rollout stalled', async () => {
    const { service, repo } = build([operation({ targetVersion: '99.0.0' })]);
    await service.failStalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('fails an update whose API never came back on the new version', async () => {
    const long = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const { service, repo } = build([
      operation({ targetVersion: '99.0.0', awaitingSince: long }),
    ]);
    await service.failStalled();

    const saved = repo.save.mock.calls[0][0];
    expect(saved.status).toBe(OperationStatus.FAILED);
    expect(saved.errorMessage).toContain('never came back on 99.0.0');
    expect(saved.metadata.components[0].status).toBe('failed');
  });

  it('completes rather than fails when the version caught up before the watchdog ran', async () => {
    const long = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const { service, repo } = build([
      operation({ targetVersion: RELEASE.version, awaitingSince: long }),
    ]);
    await service.failStalled();
    expect(repo.save.mock.calls[0][0].status).toBe(OperationStatus.COMPLETED);
  });
});
