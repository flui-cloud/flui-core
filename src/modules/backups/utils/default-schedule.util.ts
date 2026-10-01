import { BackupEngineClass } from '../enums/backup-engine-class.enum';

/**
 * The schedule a policy gets when nobody names one, spread across the night
 * so the runs of one installation do not all start in the same minute.
 *
 * A continuous database without one takes a single base backup and archives
 * its log onto it forever: nothing ever expires, and every restore replays
 * the whole history. A volume copy or platform backup without one runs once.
 */
export const DEFAULT_BACKUP_SCHEDULE = {
  platform: '0 2 * * *',
  continuousDatabase: '30 2 * * *',
  databaseDump: '0 3 * * *',
  volumeCopy: '30 3 * * *',
} as const;

/** How many days apart the full base backups of a continuous database are. */
export const DEFAULT_FULL_EVERY_DAYS = 7;

/** `undefined` for a class that has no default: nothing schedules it. */
export function defaultBackupSchedule(
  engineClass: BackupEngineClass,
  pointInTime = true,
): string | undefined {
  switch (engineClass) {
    case BackupEngineClass.PLATFORM:
      return DEFAULT_BACKUP_SCHEDULE.platform;
    case BackupEngineClass.DATABASE:
      return pointInTime
        ? DEFAULT_BACKUP_SCHEDULE.continuousDatabase
        : DEFAULT_BACKUP_SCHEDULE.databaseDump;
    case BackupEngineClass.VOLUME_COPY:
      return DEFAULT_BACKUP_SCHEDULE.volumeCopy;
    default:
      return undefined;
  }
}
