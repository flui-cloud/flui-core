export const DB_LIFECYCLE_QUEUE = 'db-lifecycle';

export const DB_LIFECYCLE_JOB_TYPES = {
  RUN_DB_MIGRATION: 'run-db-migration',
  RUN_DB_CUTOVER: 'run-db-cutover',
} as const;
