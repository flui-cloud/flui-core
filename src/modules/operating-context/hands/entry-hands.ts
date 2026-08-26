import { PrincipalAccess } from '../../iam/interfaces/iam.types';
import { EntryScope, reachesReader } from '../operating-context.core';

export const ENTRY_HANDS = 'ENTRY_HANDS';

/**
 * A name for the person an entry's `authorUserId` points at.
 *
 * A seam and not a repository call in the service, in the same shape
 * {@link ../placement/reader-placements#READER_PLACEMENTS} already uses: this
 * module reads other modules' tables only through a named port, so what it
 * takes from the identity directory is one line — a name — rather than a user
 * row it could later be tempted to deliver more of.
 */
export interface EntryHands {
  /** The names it could resolve. An id it has no name for is simply absent. */
  namesOf(userIds: string[]): Promise<Map<string, string>>;
}

/**
 * Who put their hand to a note, as a reader entitled to know is told it.
 *
 * A name and whether it is the reader's own, and **nothing else**: no id, no
 * address. An id is a handle that travels — it correlates this person across
 * every other surface that carries one — and an address is a way to contact
 * somebody who never agreed to be contacted about this. What the question "who
 * do I ask about this rule" actually needs is the name.
 */
export interface EntryHand {
  /** The name this installation records, or null when it records none. */
  name: string | null;
  isYou: boolean;
}

/**
 * Is this reader told whose hand it was?
 *
 * A signature is a fact about a **person**, and it travels attached to a note
 * that deliberately travels very widely: a `practice` written at the platform
 * level descends to every tenant and, through the fence, to the guests of the
 * public demonstration. Delivering the name with it would publish the names of
 * the people who run an installation to anybody who opened a trial.
 *
 * So the signature is given the reach a `rationale` has, not the one the note
 * has. That is decided rule 2 applied to one more field and not a new boundary:
 * *the practice descends, the why stays with whoever owns the level* — and who
 * wrote a rule is part of why it is the rule. It also draws the line where it
 * is useful: a reader whose access covers the level is a peer there, somebody
 * who could have written the note themselves and can now discuss or replace it.
 * A tenant handed the platform's practice is told what is done and, correctly,
 * that it is the platform's — the level itself is who to ask.
 *
 * Two clauses on top of the reach, and both narrow it:
 *
 *  - **a visitor is never told.** The demonstration is public, `isSandbox` is
 *    the existing mark of a public visitor, and no chain of grants should be
 *    able to make a real person's name a thing the trial hands out;
 *  - **your own hand is always yours.** Being told you wrote a note discloses
 *    nothing you did not do yourself.
 */
export function handIsToldTo(
  access: PrincipalAccess,
  scope: EntryScope,
  permission: string,
  readerUserId: string | null | undefined,
  hand: string | null | undefined,
): boolean {
  if (hand && readerUserId && hand === readerUserId) return true;
  if (access.isSandbox) return false;
  return reachesReader(access, { scope, nature: 'rationale', permission });
}
