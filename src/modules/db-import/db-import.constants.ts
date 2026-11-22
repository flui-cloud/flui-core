export const DB_IMPORT_QUEUE = 'db-import';

export const DB_IMPORT_JOBS = {
  COPY: 'copy',
  CUTOVER: 'cutover',
  ABORT: 'abort',
} as const;
