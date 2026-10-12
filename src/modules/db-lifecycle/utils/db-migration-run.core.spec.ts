import {
  assertSameNodes,
  baseBackupTimeoutMs,
  pooledCut,
  promoteMeasures,
  resourcesOf,
} from './db-migration-run.core';

describe('db-migration-run.core', () => {
  describe('baseBackupTimeoutMs', () => {
    const prev = process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS;
    afterEach(() => {
      if (prev === undefined) delete process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS;
      else process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS = prev;
    });

    it('defaults to six hours', () => {
      delete process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS;
      expect(baseBackupTimeoutMs()).toBe(6 * 60 * 60 * 1000);
    });

    it('takes a positive integer override and ignores anything else', () => {
      process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS = '90000';
      expect(baseBackupTimeoutMs()).toBe(90_000);
      process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS = '-5';
      expect(baseBackupTimeoutMs()).toBe(6 * 60 * 60 * 1000);
      process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS = 'soon';
      expect(baseBackupTimeoutMs()).toBe(6 * 60 * 60 * 1000);
    });
  });

  describe('resourcesOf', () => {
    it('mirrors only the resources the source declares', () => {
      expect(resourcesOf(null)).toBeUndefined();
      expect(resourcesOf({ resources: {} } as any)).toBeUndefined();
      expect(
        resourcesOf({
          resources: { memory: { request: '1Gi', limit: '2Gi' } },
        } as any),
      ).toEqual({ memory: { request: '1Gi', limit: '2Gi' } });
      expect(
        resourcesOf({
          resources: {
            cpu: { request: '500m', limit: '2' },
            memory: { request: '1Gi', limit: '2Gi' },
          },
        } as any),
      ).toEqual({
        cpu: { request: '500m', limit: '2' },
        memory: { request: '1Gi', limit: '2Gi' },
      });
    });
  });

  describe('assertSameNodes', () => {
    const link = { srcNodeId: 'a', dstNodeId: 'b' };

    it('accepts pods still on the nodes the link was built for', () => {
      expect(() =>
        assertSameNodes(link, { nodeId: 'a' }, { nodeId: 'b' }),
      ).not.toThrow();
    });

    it('refuses a pod that moved on either side', () => {
      expect(() =>
        assertSameNodes(link, { nodeId: 'c' }, { nodeId: 'b' }),
      ).toThrow(/moved to another node/);
      expect(() =>
        assertSameNodes(link, { nodeId: 'a' }, { nodeId: 'c' }),
      ).toThrow(/moved to another node/);
    });
  });

  describe('pooledCut', () => {
    const service = { name: 'cut' };

    it('returns the service only when the migration planned a pooler cut', () => {
      expect(pooledCut(service, { poolerCut: { poolers: [{}] } as any })).toBe(
        service,
      );
      expect(
        pooledCut(service, { poolerCut: { poolers: [] } as any }),
      ).toBeNull();
      expect(pooledCut(service, { poolerCut: undefined })).toBeNull();
      expect(
        pooledCut(undefined, { poolerCut: { poolers: [{}] } as any }),
      ).toBeNull();
    });
  });

  describe('promoteMeasures', () => {
    const now = new Date('2026-10-12T10:00:05.000Z');

    it('starts the pause at the fence when no pooler paused', () => {
      expect(
        promoteMeasures(
          { fence: { appliedAt: '2026-10-12T10:00:02.000Z' } as any },
          now,
        ),
      ).toEqual({
        writesStoppedAt: new Date('2026-10-12T10:00:02.000Z'),
        promoteConfirmedAt: now,
        writePauseMs: 3000,
      });
    });

    it('starts the pause when the poolers paused, ahead of the fence', () => {
      expect(
        promoteMeasures(
          {
            poolerCut: { pausedAt: '2026-10-12T10:00:01.000Z' } as any,
            fence: { appliedAt: '2026-10-12T10:00:02.000Z' } as any,
          },
          now,
        ).writePauseMs,
      ).toBe(4000);
    });

    it('leaves the pause unknown without a usable start', () => {
      expect(
        promoteMeasures({ fence: { appliedAt: 'now' } as any }, now),
      ).toEqual({
        writesStoppedAt: null,
        promoteConfirmedAt: now,
        writePauseMs: null,
      });
    });
  });
});
