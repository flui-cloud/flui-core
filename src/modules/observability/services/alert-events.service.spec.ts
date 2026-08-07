import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AlertEventsService, IncomingAlert } from './alert-events.service';
import { AlertEventEntity } from '../entities/alert-event.entity';

const STARTS_AT = new Date('2026-07-18T10:00:00.000Z');

const incoming = (overrides: Partial<IncomingAlert> = {}): IncomingAlert => ({
  fingerprint: 'fp-1',
  status: 'firing',
  startsAt: STARTS_AT,
  alertname: 'FluiAppDown',
  severity: 'critical',
  fluiKind: 'application',
  applicationId: 'app-1',
  applicationSlug: 'api',
  namespace: 'default',
  labels: { alertname: 'FluiAppDown' },
  annotations: { summary: 'api is down' },
  ...overrides,
});

describe('AlertEventsService', () => {
  let service: AlertEventsService;
  let findOne: jest.Mock;
  let find: jest.Mock;
  let save: jest.Mock;
  let del: jest.Mock;
  let configGet: jest.Mock;

  beforeEach(async () => {
    findOne = jest.fn().mockResolvedValue(null);
    find = jest.fn().mockResolvedValue([]);
    save = jest.fn().mockImplementation((entity) => Promise.resolve(entity));
    del = jest.fn().mockResolvedValue({ affected: 0 });
    configGet = jest.fn().mockReturnValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlertEventsService,
        {
          provide: getRepositoryToken(AlertEventEntity),
          useValue: {
            findOne,
            find,
            save,
            delete: del,
            create: (data: Partial<AlertEventEntity>) => ({ ...data }),
          },
        },
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    service = module.get(AlertEventsService);
  });

  describe('recording', () => {
    it('inserts a new episode and reports it as fired', async () => {
      const transitions = await service.record([incoming()]);

      expect(save).toHaveBeenCalledTimes(1);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].kind).toBe('fired');
    });

    // Alertmanager re-sends a firing alert every repeat_interval. Treating that as news
    // would page someone every four hours about an incident they already know about.
    it('updates in place on a repeat and reports nothing', async () => {
      findOne.mockResolvedValue({
        id: 'row-1',
        status: 'firing',
        annotations: { summary: 'stale' },
        labels: {},
      });

      const transitions = await service.record([
        incoming({ annotations: { summary: 'still down' } }),
      ]);

      expect(transitions).toHaveLength(0);
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'row-1',
          status: 'firing',
          annotations: { summary: 'still down' },
        }),
      );
    });

    it('reports a firing row turning resolved', async () => {
      findOne.mockResolvedValue({
        id: 'row-1',
        status: 'firing',
        annotations: {},
        labels: {},
      });
      const endsAt = new Date('2026-07-18T10:30:00.000Z');

      const transitions = await service.record([
        incoming({ status: 'resolved', endsAt }),
      ]);

      expect(transitions).toHaveLength(1);
      expect(transitions[0].kind).toBe('resolved');
      // endsAt comes from the payload: when the condition cleared, not when we heard.
      expect(transitions[0].event.endsAt).toEqual(endsAt);
      expect(transitions[0].event.resolvedBy).toBe('alertmanager');
    });

    it('does not announce a resolve for an episode it never saw fire', async () => {
      const transitions = await service.record([
        incoming({ status: 'resolved' }),
      ]);

      expect(save).toHaveBeenCalledTimes(1);
      expect(transitions).toHaveLength(0);
    });

    // A retry can race a group flush; the unique constraint is what keeps that safe.
    it('swallows a unique violation from a concurrent insert', async () => {
      save.mockRejectedValueOnce({ code: '23505' });

      const transitions = await service.record([incoming()]);

      expect(transitions).toHaveLength(0);
    });

    // Alertmanager retries the whole POST, so failing the batch would replay the
    // alerts that had already been stored.
    it('keeps recording the batch when one alert fails', async () => {
      save
        .mockRejectedValueOnce(new Error('boom'))
        .mockImplementationOnce((entity) => Promise.resolve(entity));

      const transitions = await service.record([
        incoming({ fingerprint: 'fp-bad' }),
        incoming({ fingerprint: 'fp-good' }),
      ]);

      expect(save).toHaveBeenCalledTimes(2);
      expect(transitions).toHaveLength(1);
    });
  });

  describe('staleness', () => {
    it('closes a firing row that stopped repeating', async () => {
      const lastSeenAt = new Date('2026-07-18T02:00:00.000Z');
      find.mockResolvedValue([{ id: 'row-1', status: 'firing', lastSeenAt }]);

      const closed = await service.resolveStale();

      expect(closed).toBe(1);
      expect(save).toHaveBeenCalledWith([
        expect.objectContaining({
          status: 'resolved',
          resolvedBy: 'timeout',
          // The end time is when it was last seen — the only honest value available.
          endsAt: lastSeenAt,
        }),
      ]);
    });

    it('does nothing when every firing row is still repeating', async () => {
      const closed = await service.resolveStale();

      expect(closed).toBe(0);
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('retention', () => {
    it('deletes only resolved rows', async () => {
      del.mockResolvedValue({ affected: 3 });

      const purged = await service.purgeOld();

      expect(purged).toBe(3);
      expect(del).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'resolved' }),
      );
    });

    it('falls back to the default when the configured retention is nonsense', async () => {
      configGet.mockReturnValue('not-a-number');

      await expect(service.purgeOld()).resolves.toBe(0);
      expect(del).toHaveBeenCalled();
    });
  });
});
