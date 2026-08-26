import type { LedgerEntry } from './ledger';
import { planScrub, sameProviderId, type DiscoveredResource } from './plan';

const RUN_AT = '2026-08-18T10:00:00.000Z';
const CLUSTER = '11111111-2222-3333-4444-555555555555';
const FLUI = { 'managed-by': 'flui-cloud', 'flui-cluster-id': CLUSTER };

const named = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  kind: 'server',
  providerId: '4242',
  name: 'flui-abc-master',
  region: 'nbg1',
  createdAt: RUN_AT,
  releasedAt: null,
  ...over,
});

const found = (over: Partial<DiscoveredResource> = {}): DiscoveredResource => ({
  provider: 'hetzner',
  kind: 'server',
  providerId: '4242',
  name: 'flui-abc-master',
  region: 'nbg1',
  labels: FLUI,
  createdAt: '2026-08-18T10:00:07.000Z',
  ...over,
});

const verdicts = (plan: ReturnType<typeof planScrub>) =>
  plan.decisions.map((d) => [d.entry.name, d.verdict]);

describe('what the plan agrees to remove', () => {
  it('removes what the list names and the account confirms is ours', () => {
    const plan = planScrub({ ledger: [named()], discovered: [found()] });
    expect(verdicts(plan)).toEqual([['flui-abc-master', 'remove']]);
    expect(plan.removals[0].match?.providerId).toBe('4242');
  });

  it('follows the provider id when the resource was renamed after creation', () => {
    // `env create` mints the firewall as flui-control-firewall-<random> and
    // renames it once the cluster is ready, so the name in the list is stale.
    const plan = planScrub({
      ledger: [named({ kind: 'firewall', name: 'flui-control-firewall-a1b2' })],
      discovered: [
        found({
          kind: 'firewall',
          name: `flui-control-firewall-${CLUSTER}`,
          createdAt: null,
        }),
      ],
    });
    expect(plan.removals).toHaveLength(1);
  });

  it('reports a resource the run already deleted, and does not act on it', () => {
    const plan = planScrub({
      ledger: [named({ releasedAt: '2026-08-18T10:04:00.000Z' })],
      discovered: [found()],
    });
    expect(verdicts(plan)).toEqual([['flui-abc-master', 'released']]);
    expect(plan.removals).toHaveLength(0);
  });

  it('says already-gone when nothing on the account answers to the entry', () => {
    const plan = planScrub({ ledger: [named()], discovered: [] });
    expect(verdicts(plan)).toEqual([['flui-abc-master', 'already-gone']]);
  });

  it('destroys servers before the keys that open them', () => {
    const plan = planScrub({
      ledger: [
        named({ kind: 'ssh-key', name: 'k', providerId: '7' }),
        named({ kind: 'firewall', name: 'f', providerId: '8' }),
        named({ name: 's', providerId: '9' }),
      ],
      discovered: [
        found({ kind: 'ssh-key', name: 'k', providerId: '7' }),
        found({
          kind: 'firewall',
          name: 'f',
          providerId: '8',
          createdAt: null,
        }),
        found({ name: 's', providerId: '9' }),
      ],
    });
    expect(plan.removals.map((d) => d.entry.kind)).toEqual([
      'server',
      'firewall',
      'ssh-key',
    ]);
  });
});

/**
 * The claim this whole command rests on. Each of these is a resource that is
 * *not* the funnel's, arriving by a different route, and none of them may be
 * touched.
 */
describe('a resource that is not the run’s is never touched', () => {
  it('refuses a namesake that carries no Flui ownership mark', () => {
    const plan = planScrub({
      ledger: [named({ providerId: null })],
      discovered: [found({ providerId: '9001', labels: {} })],
    });
    expect(verdicts(plan)).toEqual([['flui-abc-master', 'refused']]);
    expect(plan.decisions[0].reason).toContain('not ours to delete');
    expect(plan.removals).toHaveLength(0);
  });

  it('refuses even on an exact provider-id hit when the mark is absent', () => {
    const plan = planScrub({
      ledger: [named()],
      discovered: [found({ labels: {} })],
    });
    expect(plan.removals).toHaveLength(0);
    expect(plan.refusals).toHaveLength(1);
  });

  /**
   * The category `env orphan-volumes` deletes. A Flui mark says "Flui made
   * this", not "this run made this" — a second cluster on the same account
   * wears exactly the same label.
   */
  it('never removes a Flui-marked resource the list does not name', () => {
    const other = found({
      providerId: '777',
      name: 'flui-other-master',
      labels: { 'managed-by': 'flui-cloud', 'flui-cluster-id': 'other' },
    });
    const plan = planScrub({
      ledger: [named()],
      discovered: [found(), other],
    });
    expect(plan.removals.map((d) => d.match?.providerId)).toEqual(['4242']);
    expect(plan.unclaimed).toEqual([other]);
  });

  it('leaves an unmarked stranger out of the unclaimed report as well', () => {
    const plan = planScrub({
      ledger: [],
      discovered: [found({ providerId: '888', name: 'invoices', labels: {} })],
    });
    expect(plan.unclaimed).toEqual([]);
  });

  it('refuses a marked resource older than the run that announced it', () => {
    const plan = planScrub({
      ledger: [named({ providerId: null })],
      discovered: [found({ createdAt: '2026-05-01T09:00:00.000Z' })],
    });
    expect(plan.refusals).toHaveLength(1);
    expect(plan.decisions[0].reason).toContain('before the run announced it');
  });

  it('tolerates clocks that disagree by minutes', () => {
    const plan = planScrub({
      ledger: [named({ providerId: null })],
      discovered: [found({ createdAt: '2026-08-18T09:58:00.000Z' })],
    });
    expect(plan.removals).toHaveLength(1);
  });

  it('refuses when more than one resource answers to the name', () => {
    const plan = planScrub({
      ledger: [named({ providerId: null })],
      discovered: [found(), found({ provider: 'scaleway', providerId: 'zzz' })],
    });
    expect(plan.refusals).toHaveLength(1);
    expect(plan.decisions[0].reason).toContain('more than one');
  });

  it('refuses when the name matches but the recorded id does not', () => {
    const plan = planScrub({
      ledger: [named()],
      discovered: [found({ providerId: '9999' })],
    });
    expect(plan.refusals).toHaveLength(1);
    expect(plan.decisions[0].reason).toContain('9999');
  });

  it('refuses a resource whose cluster this machine still has in its store', () => {
    const plan = planScrub({
      ledger: [named()],
      discovered: [found()],
      knownClusterIds: [CLUSTER],
    });
    expect(plan.refusals).toHaveLength(1);
    expect(plan.decisions[0].reason).toContain('still has in its store');
  });

  it('refuses a volume still attached to a server it is not removing', () => {
    const plan = planScrub({
      ledger: [named({ kind: 'volume', name: 'shared', providerId: 'v1' })],
      discovered: [
        found({
          kind: 'volume',
          name: 'shared',
          providerId: 'v1',
          attachedTo: '4242',
        }),
      ],
    });
    expect(plan.refusals).toHaveLength(1);
    expect(plan.decisions[0].reason).toContain('still attached to server 4242');
  });

  it('allows the volume once the server holding it is going too', () => {
    const plan = planScrub({
      ledger: [
        named(),
        named({ kind: 'volume', name: 'shared', providerId: 'fr-par-1:v1' }),
      ],
      discovered: [
        found(),
        found({
          kind: 'volume',
          name: 'shared',
          providerId: 'fr-par-1:v1',
          attachedTo: '4242',
        }),
      ],
    });
    expect(plan.removals).toHaveLength(2);
  });
});

/**
 * The shape of the defect this command was written not to repeat: Scaleway
 * addresses a volume as `<zone>:<id>` in its block API and bare everywhere
 * else, so a safety check written as `a === b` stops firing on exactly the
 * provider where volumes cost the most to leave running.
 */
describe('provider ids that are the same resource in two spellings', () => {
  it.each([
    ['fr-par-1:abcd', 'abcd'],
    ['abcd', 'fr-par-1:abcd'],
    ['fr-par-1:abcd', 'fr-par-1:abcd'],
  ])('treats %s and %s as one', (a, b) => {
    expect(sameProviderId(a, b)).toBe(true);
  });

  it.each([
    ['fr-par-1:abcd', 'fr-par-1:efgh'],
    ['', 'abcd'],
    ['abcd', ''],
  ])('keeps %s and %s apart', (a, b) => {
    expect(sameProviderId(a, b)).toBe(false);
  });

  it('matches a ledger id written bare against a zone-qualified volume', () => {
    const plan = planScrub({
      ledger: [named({ kind: 'volume', name: 'shared', providerId: 'abcd' })],
      discovered: [
        found({
          kind: 'volume',
          name: 'shared-renamed',
          providerId: 'fr-par-1:abcd',
        }),
      ],
    });
    expect(plan.removals).toHaveLength(1);
  });
});
