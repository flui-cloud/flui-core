import { ResolvedApp } from '../../db-lifecycle/services/db-pod-exec.service';
import { DbImportEntity } from '../entities/db-import.entity';

export interface ImportContext {
  row: DbImportEntity;
  target: ResolvedApp;
  /** The database inside the target server the import fills. */
  targetDatabase: string;
  password: string;
}

export interface ImportProgress {
  /** Every table is copied and changes now follow. */
  streaming: boolean;
  lagSeconds: number | null;
}

/** One database engine's way through an import; the service holds the states. */
export interface ImportRunner {
  /** Checks the source, copies, starts following it. Returns why it refused, or null once it follows. */
  copy(ctx: ImportContext): Promise<string | null>;
  progress(ctx: ImportContext): Promise<ImportProgress>;
  /** Nothing left to apply, twice in a row; false after the catch-up window. */
  caughtUp(ctx: ImportContext): Promise<boolean>;
  /** Once caught up: aligns what replication does not carry, detaches, undoes. Returns what could not be undone. */
  finish(ctx: ImportContext): Promise<string[]>;
  /** Stops following the source and undoes what the import added, as far as it can. */
  cleanUp(ctx: ImportContext): Promise<string[]>;
}

/** How long the switch waits for the copy to catch up with a source whose writes were stopped. */
export const CATCH_UP_MS =
  Number(process.env.DB_IMPORT_CATCH_UP_SECONDS ?? 120) * 1000;
export const CATCH_UP_POLL_MS = 3000;

export async function twiceQuiet(
  isQuiet: () => Promise<boolean>,
): Promise<boolean> {
  let quiet = 0;
  const deadline = Date.now() + CATCH_UP_MS;
  while (Date.now() < deadline) {
    quiet = (await isQuiet()) ? quiet + 1 : 0;
    if (quiet >= 2) return true;
    await new Promise((r) => setTimeout(r, CATCH_UP_POLL_MS));
  }
  return false;
}
