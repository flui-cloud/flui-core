/**
 * The one place where two spellings of the same volume become one answer.
 *
 * A provider does not address a volume the same way everywhere. Scaleway's
 * block API answers `<zone>:<uuid>` when it lists and takes the bare uuid in
 * other places, and the two forms are the same disk. Flui's own registry holds
 * whichever form the code path that wrote it happened to have — which is why
 * the destroy path has to *add* the zone back before it can call the provider
 * (`formatVolumeRef` in `cluster-queue.processor.ts`): the same divergence,
 * seen from the other side. Hetzner ids are bare numbers and pass through
 * untouched.
 *
 * Comparing the raw strings is how a safety check quietly stops firing: the
 * registry says `fr-par-1:abc`, the provider says `abc`, a plain `Set.has`
 * answers "not ours", and the shared storage of a live cluster is deleted.
 * That is the entire reason this file exists.
 *
 * So the rule is not offered as a helper somebody has to remember to call.
 * {@link KnownVolumeRefs} is the only way to ask whether a volume is known to
 * the registry: it normalises the ids it is given *and* the id it is asked
 * about, and it never hands the raw strings back — the wrong comparison cannot
 * be written against it.
 */

/**
 * The form both sides are reduced to: the segment after the last colon, cased
 * down. `fr-par-1:abc`, `instance:fr-par-1:abc` and `ABC` all read as `abc`;
 * a Hetzner `12345` reads as itself. Anything with no readable tail — empty,
 * blank, `fr-par-1:` — reads as `null`, which is not "no match" but "cannot be
 * read", and a caller about to delete something must treat it as a refusal
 * rather than as permission.
 */
export function normalizeVolumeRef(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const colon = trimmed.lastIndexOf(':');
  const tail = colon >= 0 ? trimmed.slice(colon + 1).trim() : trimmed;
  return tail ? tail.toLowerCase() : null;
}

/** True when both ids are readable and name the same volume. */
export function sameVolumeRef(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizeVolumeRef(a);
  return left !== null && left === normalizeVolumeRef(b);
}

/**
 * The volumes Flui's registry still points at, asked about by any spelling.
 *
 * Deliberately not a `Set<string>`. A set invites `has(raw)`, and `has(raw)` is
 * the bug. This exposes membership only, normalised on both ends, with no way
 * to read the stored ids back out.
 */
export class KnownVolumeRefs {
  private readonly refs = new Set<string>();

  add(raw: string | null | undefined): void {
    const ref = normalizeVolumeRef(raw);
    if (ref) this.refs.add(ref);
  }

  /**
   * Whether the registry still points at this volume. An unreadable id answers
   * `false` — it is not a claim that the volume is free, and the caller is
   * expected to have refused it before ever getting here.
   */
  has(raw: string | null | undefined): boolean {
    const ref = normalizeVolumeRef(raw);
    return ref !== null && this.refs.has(ref);
  }

  get size(): number {
    return this.refs.size;
  }
}
