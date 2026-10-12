import {
  FullCutoverMode,
  FullMigrationStatus,
} from '../enums/full-migration.enum';
import { FULL_MIGRATION_JOB_TYPES } from '../full-migration.constants';
import {
  canResumeCutover,
  jobMigrationIds,
  needsStartupResume,
  startupResumeJob,
} from './full-migration-service.core';

describe('full-migration service core', () => {
  it('resumes a FAILED_FORWARD cutover, and a CUTOVER one only when no job holds it', () => {
    const fm = (status: FullMigrationStatus) => ({ id: 'fm-1', status });
    expect(
      canResumeCutover(fm(FullMigrationStatus.FAILED_FORWARD), undefined),
    ).toBe(true);
    expect(canResumeCutover(fm(FullMigrationStatus.CUTOVER), new Set())).toBe(
      true,
    );
    expect(
      canResumeCutover(fm(FullMigrationStatus.CUTOVER), new Set(['fm-1'])),
    ).toBe(false);
    expect(canResumeCutover(fm(FullMigrationStatus.CUTOVER), undefined)).toBe(
      false,
    );
    expect(canResumeCutover(fm(FullMigrationStatus.READY), new Set())).toBe(
      false,
    );
  });

  it('resumes at startup every pre-cutover run except a manual one parked at READY', () => {
    const fm = (
      status: FullMigrationStatus,
      cutoverMode = FullCutoverMode.AUTO,
    ) => ({
      status,
      cutoverMode,
    });
    expect(needsStartupResume(fm(FullMigrationStatus.CUTOVER))).toBe(true);
    expect(needsStartupResume(fm(FullMigrationStatus.READY))).toBe(true);
    expect(
      needsStartupResume(fm(FullMigrationStatus.READY, FullCutoverMode.MANUAL)),
    ).toBe(false);
    expect(needsStartupResume(fm(FullMigrationStatus.COMPLETED))).toBe(false);
  });

  it('names the startup job after the state and the row version', () => {
    const updatedAt = new Date(7);
    expect(
      startupResumeJob({
        id: 'a',
        status: FullMigrationStatus.CUTOVER,
        updatedAt,
      }),
    ).toEqual({
      name: FULL_MIGRATION_JOB_TYPES.RUN_FULL_CUTOVER,
      jobId: 'resume-cutover:a:7',
    });
    expect(
      startupResumeJob({
        id: 'b',
        status: FullMigrationStatus.PENDING,
        updatedAt: undefined as any,
      }),
    ).toEqual({
      name: FULL_MIGRATION_JOB_TYPES.RUN_FULL_MIGRATION,
      jobId: 'resume-run:b:0',
    });
  });

  it('collects the migration ids the queued jobs hold', () => {
    expect(
      jobMigrationIds([
        { data: { migrationId: 'a' } },
        { data: {} },
        null as any,
        { data: { migrationId: 'b' } },
      ]),
    ).toEqual(new Set(['a', 'b']));
  });
});
