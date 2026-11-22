import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { DbImportService } from '../services/db-import.service';
import { DB_IMPORT_JOBS, DB_IMPORT_QUEUE } from '../db-import.constants';

@Processor(DB_IMPORT_QUEUE)
export class DbImportProcessor {
  constructor(private readonly imports: DbImportService) {}

  @Process(DB_IMPORT_JOBS.COPY)
  copy(job: Job<{ importId: string }>): Promise<void> {
    return this.imports.runCopy(job.data.importId);
  }

  @Process(DB_IMPORT_JOBS.CUTOVER)
  cutover(job: Job<{ importId: string }>): Promise<void> {
    return this.imports.runCutover(job.data.importId);
  }

  @Process(DB_IMPORT_JOBS.ABORT)
  abort(job: Job<{ importId: string }>): Promise<void> {
    return this.imports.runAbort(job.data.importId);
  }
}
