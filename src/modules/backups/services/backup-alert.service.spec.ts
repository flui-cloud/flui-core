jest.mock('@kubernetes/client-node', () => ({}));

import { BackupAlertService } from './backup-alert.service';
import { BackupJobStatus } from '../enums/backup-job.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { AlertEventsService } from '../../observability/services/alert-events.service';
import { AlertRoutingService } from '../../observability/services/alert-routing.service';

function harness(engineClass: BackupEngineClass) {
  const events: Array<{ fingerprint: string; status: string; startsAt: Date }> =
    [];
  const record = jest.fn(async (alerts: Array<Record<string, any>>) => {
    const a = alerts[0];
    const existing = events.find(
      (e) => e.fingerprint === a.fingerprint && e.startsAt === a.startsAt,
    );
    if (!existing) {
      events.push({
        fingerprint: a.fingerprint,
        status: a.status,
        startsAt: a.startsAt,
      });
      return a.status === 'firing' ? [{ kind: 'fired', event: a }] : [];
    }
    const was = existing.status;
    existing.status = a.status;
    return was === 'firing' && a.status === 'resolved'
      ? [{ kind: 'resolved', event: a }]
      : [];
  });
  const deliver = jest.fn().mockResolvedValue(undefined);
  const svc = new BackupAlertService(
    {
      findOne: async () => ({
        id: 'j1',
        policyId: 'p1',
        errorMessage: 'bucket unreachable',
      }),
    } as never,
    {
      findOne: async () => ({
        id: 'p1',
        name: 'nightly',
        engineClass,
        clusterId: 'c1',
        userId: 'owner-1',
      }),
    } as never,
    {
      findOne: async () => events.find((e) => e.status === 'firing') ?? null,
    } as never,
    {
      get: (token: unknown) =>
        token === AlertEventsService
          ? { record }
          : token === AlertRoutingService
            ? { deliver }
            : undefined,
    } as never,
  );
  return { svc, record, deliver, events };
}

describe('BackupAlertService', () => {
  it('raises the alert on the first failure only, and closes it on the next success', async () => {
    const h = harness(BackupEngineClass.VOLUME_COPY);
    await h.svc.settled('j1', BackupJobStatus.FAILED);
    await h.svc.settled('j1', BackupJobStatus.FAILED);
    await h.svc.settled('j1', BackupJobStatus.COMPLETED);
    expect(h.deliver.mock.calls.map((c) => c[0])).toEqual([
      'fired',
      'resolved',
    ]);
    expect(h.deliver.mock.calls[0][1]).toMatchObject({
      alertname: 'FluiBackupFailed',
      severity: 'warning',
    });
    expect(h.deliver.mock.calls[0][2]).toEqual({ ownerUserId: 'owner-1' });
    expect(h.deliver.mock.calls[0][1].annotations.summary).toContain(
      'bucket unreachable',
    );
  });

  it('records nothing for a success with no failure open', async () => {
    const h = harness(BackupEngineClass.VOLUME_COPY);
    await h.svc.settled('j1', BackupJobStatus.COMPLETED);
    expect(h.record).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('treats a failed platform backup as critical and tells the administrators', async () => {
    const h = harness(BackupEngineClass.PLATFORM);
    await h.svc.settled('j1', BackupJobStatus.FAILED);
    expect(h.deliver.mock.calls[0][1].severity).toBe('critical');
    expect(h.deliver.mock.calls[0][2]).toEqual({ ownerUserId: null });
  });

  it('neither opens nor closes an episode on a partial run', async () => {
    const h = harness(BackupEngineClass.VOLUME_COPY);
    await h.svc.settled('j1', BackupJobStatus.PARTIALLY_COMPLETED);
    expect(h.record).not.toHaveBeenCalled();

    await h.svc.settled('j1', BackupJobStatus.FAILED);
    await h.svc.settled('j1', BackupJobStatus.PARTIALLY_COMPLETED);
    expect(h.deliver.mock.calls.map((c) => c[0])).toEqual(['fired']);
    expect(h.events.filter((e) => e.status === 'firing')).toHaveLength(1);

    await h.svc.settled('j1', BackupJobStatus.COMPLETED);
    expect(h.deliver.mock.calls.map((c) => c[0])).toEqual([
      'fired',
      'resolved',
    ]);
  });

  it('opens one episode when two runs of the same policy fail together', async () => {
    const h = harness(BackupEngineClass.VOLUME_COPY);
    await Promise.all([
      h.svc.settled('j1', BackupJobStatus.FAILED),
      h.svc.settled('j2', BackupJobStatus.FAILED),
    ]);
    expect(h.events).toHaveLength(1);
    expect(h.deliver.mock.calls.map((c) => c[0])).toEqual(['fired']);
  });

  it('ignores states that are not an outcome', async () => {
    const h = harness(BackupEngineClass.VOLUME_COPY);
    await h.svc.settled('j1', BackupJobStatus.RUNNING);
    expect(h.record).not.toHaveBeenCalled();
  });
});
