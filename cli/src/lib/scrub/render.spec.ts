import type { LedgerEntry } from './ledger';
import { planScrub, type DiscoveredResource } from './plan';
import { renderPlan } from './render';

const CLUSTER = '11111111-2222-3333-4444-555555555555';

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  kind: 'server',
  providerId: '4242',
  name: 'flui-demo-master',
  region: 'nbg1',
  createdAt: '2026-08-18T10:00:00.000Z',
  releasedAt: null,
  ...over,
});

const resource = (
  over: Partial<DiscoveredResource> = {},
): DiscoveredResource => ({
  provider: 'hetzner',
  kind: 'server',
  providerId: '4242',
  name: 'flui-demo-master',
  labels: { 'managed-by': 'flui-cloud', 'flui-cluster-id': CLUSTER },
  createdAt: '2026-08-18T10:00:04.000Z',
  ...over,
});

const render = (
  input: Parameters<typeof planScrub>[0],
  blind: string[] = [],
): string => renderPlan(planScrub(input), blind).join('\n');

describe('what the customer is shown before anything is deleted', () => {
  it('names each resource, its verdict and the provider id it resolved to', () => {
    const text = render({ ledger: [entry()], discovered: [resource()] });
    expect(text).toContain('remove');
    expect(text).toContain('flui-demo-master');
    expect(text).toContain('hetzner/4242');
  });

  it('says why a refusal was refused', () => {
    const text = render({
      ledger: [entry()],
      discovered: [resource({ labels: {} })],
    });
    expect(text).toContain('refused');
    expect(text).toContain('not ours to delete');
    expect(text).not.toContain('remove ');
  });

  it('lists what it found but will not touch', () => {
    const text = render({
      ledger: [],
      discovered: [resource({ providerId: '777', name: 'other-master' })],
    });
    expect(text).toContain('1 other Flui-managed resource(s)');
    expect(text).toContain('other-master (hetzner/777)');
  });

  it('says nothing about resources it never saw', () => {
    const text = render({
      ledger: [],
      discovered: [resource({ name: 'customer-mail-server', labels: {} })],
    });
    expect(text).not.toContain('customer-mail-server');
  });

  it('surfaces a listing that failed rather than hiding a partial view', () => {
    const text = render({ ledger: [], discovered: [] }, [
      'Could not list servers on hetzner: 503',
    ]);
    expect(text).toContain('Could not list servers on hetzner');
  });
});
