import { RELEASE } from '../../../config/release.config';
import { PlatformUpdateResumeService } from './platform-update-resume.service';
import {
  OperationStatus,
  PlatformUpdateOperationMetadata,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';

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
  return { service: new PlatformUpdateResumeService(repo as never), repo };
}

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
