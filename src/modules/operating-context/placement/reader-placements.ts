import { PrincipalAccess } from '../../iam/interfaces/iam.types';
import { Placement } from '../operating-context.core';

export const READER_PLACEMENTS = 'READER_PLACEMENTS';

/**
 * Where a principal's resources actually sit.
 *
 * A door rather than an import: answering it means reading the application
 * inventory, and pulling that module into this one to ask one question would
 * drag the whole of it — entities, relations, services — behind a feature whose
 * entire job is to hold two hundred lines of advice. One method, one direction,
 * substitutable in a test.
 *
 * **`null` is a real answer and it is not an empty list.** Empty means "this
 * principal's resources sit nowhere" — a tenant with no applications — and it
 * narrows. `null` means the question could not be answered at all, and it
 * narrows nothing: an inventory that is briefly unreadable must not quietly
 * stop the local practice from reaching the people it was written for.
 */
export interface ReaderPlacements {
  placementsOf(
    access: PrincipalAccess,
    permission: string,
  ): Promise<Placement[] | null>;
}
