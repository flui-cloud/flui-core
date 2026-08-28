export const CLUSTER_REFERENCES = 'CLUSTER_REFERENCES';

/**
 * The one spelling of a cluster this feature stores.
 *
 * A cluster note carries a `scopeRef`, and every rule that decides who reads it
 * compares that string against another one. Nothing resolved it, so the same
 * cluster could be — and on the live instance was — recorded twice: once as
 * `f94b9c06-…` by the dashboard and once as `control-cluster` by somebody
 * typing `--cluster control-cluster` at a terminal. Two sets of notes about one
 * cluster, each invisible from the other's spelling, and no reader anywhere
 * that could tell they were about the same thing.
 *
 * The id wins, not the name: a cluster can be renamed and its notes must
 * survive it.
 *
 * A door rather than an import, for the same reason {@link ReaderPlacements} is
 * one — this module holds two hundred lines of advice and does not drag the
 * infrastructure module in behind it to ask one question.
 */
export interface ClusterReferences {
  /**
   * The canonical id for a reference that may be an id or a name, or `null`
   * when nothing on this installation answers to it.
   *
   * `null` means *no such cluster*, and the write refuses on it: a note naming
   * a cluster that does not exist is a note nobody will ever read, and letting
   * it through spends the author's care on nothing. It is deliberately NOT the
   * "could not answer" signal that `placementsOf` has — a repository that
   * cannot be read throws, and a 500 that somebody investigates is the right
   * outcome there, unlike a silent narrowing on the read path.
   */
  canonicalIdOf(reference: string): Promise<string | null>;
}
