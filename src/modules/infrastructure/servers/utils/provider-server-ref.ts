/**
 * The one place where two spellings of the same server become one answer.
 *
 * A provider does not address a server the same way everywhere. Scaleway
 * builds the id Flui carries around as `instance:<zone>:<uuid>`
 * (`buildInstanceResourceId`), but the block API, asked which server a volume
 * hangs off, answers with the bare `product_resource_id` — the uuid alone.
 * Both name the same machine. Hetzner ids are bare numbers on both sides and
 * pass through untouched, which is why this only ever broke on Scaleway.
 *
 * Comparing the raw strings is how the product ends up paying for disks it has
 * forgotten: `String(v.attachedServerId) === String(serverId)` can never be
 * true on Scaleway, so a volume Flui itself created is not recognised as this
 * server's, its id is never recorded on the cluster, and it is neither billed
 * nor destroyed with the cluster. It becomes an orphan.
 *
 * So the rule is not offered as a helper somebody has to remember to call.
 * {@link ServerRef} is the only way to ask whether a volume hangs off a given
 * server: it normalises the id it is built from *and* the id it is asked
 * about, and it never hands either string back — the wrong comparison cannot
 * be written against it.
 *
 * Twin of `KnownVolumeRefs` (`clusters/utils/provider-volume-ref.ts`), not a
 * reuse of it: that one answers set membership over the volume ids a registry
 * still points at, this one is a single server identity asked whether a
 * foreign field names it. The string rule is deliberately restated here rather
 * than imported, so neither module exports a bare normaliser its callers could
 * forget to use.
 */

/**
 * The form both sides are reduced to: the segment after the last colon, cased
 * down. `instance:fr-par-1:abc`, `fr-par-1:abc` and `ABC` all read as `abc`;
 * a Hetzner `12345` reads as itself. Anything with no readable tail — empty,
 * blank, `instance:fr-par-1:` — reads as `null`, which is not "no match" but
 * "cannot be read", and a caller that is about to attribute a paid resource
 * must treat it as a refusal rather than as permission.
 *
 * Not exported: a bare normaliser in scope is an invitation to compare its
 * output by hand, which is the bug this file exists to make unwritable.
 */
function serverIdentity(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const colon = trimmed.lastIndexOf(':');
  const tail = colon >= 0 ? trimmed.slice(colon + 1).trim() : trimmed;
  return tail ? tail.toLowerCase() : null;
}

/**
 * One server, asked about by any spelling its provider uses.
 *
 * Deliberately not a string alias. A string invites `===`, and `===` is the
 * bug. This exposes one question — "is this attachment mine?" — normalised on
 * both ends, with no way to read the identity back out.
 */
export class ServerRef {
  private constructor(private readonly identity: string) {}

  /**
   * `null` when the id carries no readable identity. That is a refusal, not a
   * server that matches nothing: a caller holding `null` does not know which
   * machine it is talking about and must not attribute anything to it.
   */
  static parse(raw: string | null | undefined): ServerRef | null {
    const identity = serverIdentity(raw);
    return identity ? new ServerRef(identity) : null;
  }

  /**
   * Whether a resource reporting `attachedServerId` hangs off this server. An
   * unreadable or absent attachment answers `false` — the resource is attached
   * to nothing this code can name, which is never a reason to claim it.
   */
  ownsAttachment(rawAttachedServerId: string | null | undefined): boolean {
    const attached = serverIdentity(rawAttachedServerId);
    return attached !== null && attached === this.identity;
  }
}
