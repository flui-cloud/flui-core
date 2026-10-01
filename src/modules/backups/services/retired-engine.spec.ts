jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BackupPoliciesService } from './backup-policies.service';
import { BackupJobsService } from './backup-jobs.service';
import { RestoreJobsService } from './restore-jobs.service';
import { BackupStatusService } from './backup-status.service';
import { CreateBackupPolicyDto } from '../dto/create-backup-policy.dto';
import { CreateRestoreJobDto } from '../dto/create-restore-job.dto';
import {
  BackupEngineClass,
  ENGINE_REMOVED_REASON,
} from '../enums/backup-engine-class.enum';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';
import { OperationStatus } from '../../infrastructure/servers/entities/infrastructure-operations.entity';

const RETIRED = 'volume' as BackupEngineClass;

describe('the retired cluster-wide engine', () => {
  it('is no longer a class a policy can be created with', async () => {
    const dto = plainToInstance(CreateBackupPolicyDto, {
      name: 'n',
      clusterId: '3f29f52b-4c9e-4c1e-9b1e-2f5a9d1e7700',
      scope: 'cluster_all',
      engineClass: 'volume',
      destinations: [],
    });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain('engineClass');
  });

  it('refuses to resume one of its policies', async () => {
    const repo = {
      findById: jest.fn(async () => ({
        id: 'p1',
        engineClass: RETIRED,
        metadata: { pausedReason: ENGINE_REMOVED_REASON },
        destinations: [],
      })),
      update: jest.fn(),
    };
    const service = new BackupPoliciesService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(service.resume('p1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('runs nothing, and records no job or operation, when asked to run one of its policies', async () => {
    const jobRepo = { create: jest.fn(), save: jest.fn() };
    const opRepo = { create: jest.fn(), save: jest.fn() };
    const queue = { add: jest.fn() };
    const service = new BackupJobsService(
      jobRepo as never,
      {} as never,
      {
        findById: async () => ({
          id: 'p1',
          clusterId: 'c1',
          engineClass: RETIRED,
          status: BackupPolicyStatus.ACTIVE,
        }),
      } as never,
      opRepo as never,
      queue as never,
    );
    await expect(
      service.createOnDemand('u1', { policyId: 'p1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(opRepo.save).not.toHaveBeenCalled();
    expect(jobRepo.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not restore one of its backups, and says the data is still in the destination', async () => {
    const opRepo = { create: jest.fn(), save: jest.fn() };
    const service = new RestoreJobsService(
      {} as never,
      {
        findArtifact: async () => ({ id: 'a1', engineClass: RETIRED }),
      } as never,
      opRepo as never,
      { add: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const err = await service
      .create('u1', {
        artifactId: 'a1',
        sourceDestinationId: 'd1',
        targetClusterId: 'c1',
        targetKind: 'namespace',
      } as never)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain('still in the destination');
    expect(opRepo.save).not.toHaveBeenCalled();
  });

  it('restores only databases through the restore pipeline', async () => {
    const service = new RestoreJobsService(
      {} as never,
      {
        findArtifact: async () => ({
          id: 'a1',
          engineClass: BackupEngineClass.VOLUME_COPY,
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.create('u1', {
        artifactId: 'a1',
        sourceDestinationId: 'd1',
        targetClusterId: 'c1',
        targetKind: 'application',
      } as never),
    ).rejects.toThrow('flui app backup restore');
  });

  it('no longer offers its restore strategy', async () => {
    const dto = plainToInstance(CreateRestoreJobDto, {
      artifactId: '3f29f52b-4c9e-4c1e-9b1e-2f5a9d1e7700',
      sourceDestinationId: '3f29f52b-4c9e-4c1e-9b1e-2f5a9d1e7701',
      targetClusterId: '3f29f52b-4c9e-4c1e-9b1e-2f5a9d1e7702',
      targetKind: 'database',
      strategy: 'velero_rebuild',
    });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain('strategy');
  });

  describe('in the backup status', () => {
    function status(uninstalled: boolean) {
      const find = (rows: unknown[]) => ({ find: jest.fn(async () => rows) });
      const qb = {
        where: () => qb,
        andWhere: () => qb,
        getMany: async () => [],
      };
      return new BackupStatusService(
        find([{ id: 'c1', name: 'wc-1' }]) as never,
        find([
          {
            id: 'p1',
            clusterId: 'c1',
            engineClass: RETIRED,
            enabled: false,
            status: BackupPolicyStatus.PAUSED,
            metadata: { pausedReason: ENGINE_REMOVED_REASON },
          },
        ]) as never,
        find([]) as never,
        { createQueryBuilder: () => qb } as never,
        find([]) as never,
        find([]) as never,
        undefined,
        undefined,
        {
          find: jest.fn(async () =>
            uninstalled
              ? [{ resourceId: 'c1', status: OperationStatus.COMPLETED }]
              : [],
          ),
        } as never,
      );
    }

    it('says which cluster may still run it and how to remove it', async () => {
      const res = await status(false).getStatus('u1');
      const alert = res.alerts.find(
        (a) => a.code === 'RETIRED_BACKUP_ENGINE_INSTALLED',
      );
      expect(alert).toMatchObject({ severity: 'info', resourceId: 'c1' });
      expect(alert?.message).toContain('flui backup velero uninstall wc-1');
    });

    it('stops saying it once the removal has completed', async () => {
      const res = await status(true).getStatus('u1');
      expect(
        res.alerts.some((a) => a.code === 'RETIRED_BACKUP_ENGINE_INSTALLED'),
      ).toBe(false);
    });
  });
});
