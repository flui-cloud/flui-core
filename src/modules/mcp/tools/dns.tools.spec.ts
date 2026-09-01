import { DNS_TOOLS } from './dns.tools';
import { McpToolContext, ToolDef } from './mcp-tool.util';

/**
 * One tool call, one governed request.
 *
 * `POST /clusters/:clusterId/dns-zone/:assignmentId/wildcard` is inside the
 * action cycle, so a publish that fanned out over every assigned zone raised
 * one question per zone from a single call. The person answered the first, the
 * agent retried, one zone was published for real and the other refused again —
 * and the wait the agent was handed says "NOTHING was changed and nothing
 * failed", about a cluster where a DNS record had just been written. Multi-zone
 * clusters are a real configuration, so the fan-out is what had to go.
 */
const publish = DNS_TOOLS.find((t) => t.name === 'dns_wildcard_publish')
  ?.run as NonNullable<ToolDef['run']>;

function ctxOver(
  zones: Array<{ id: string; name?: string }>,
  posts: string[],
): McpToolContext {
  const api = {
    get: jest.fn(async (path: string) => {
      if (path === '/infrastructure/clusters') return [{ id: 'c1' }];
      return zones.map((z) => ({
        id: z.id,
        dnsZone: z.name ? { zoneName: z.name } : {},
      }));
    }),
    post: jest.fn(async (path: string) => {
      posts.push(path);
      return { status: 'published', fqdn: '*.c1.example.com' };
    }),
  };
  return { api } as unknown as McpToolContext;
}

describe('publishing the wildcard record', () => {
  it('publishes without asking when the cluster carries one zone', async () => {
    const posts: string[] = [];
    const ctx = ctxOver([{ id: 'z1', name: 'example.com' }], posts);

    const rows = (await publish({}, ctx)) as Array<{ zone: string | null }>;

    expect(posts).toEqual(['/clusters/c1/dns-zone/z1/wildcard']);
    expect(rows).toHaveLength(1);
    expect(rows[0].zone).toBe('example.com');
  });

  /**
   * The case the whole change is about: nothing is written, and what the model
   * is told is something it can act on rather than a half-done publish.
   */
  it('writes nothing and asks which one when several zones are assigned', async () => {
    const posts: string[] = [];
    const ctx = ctxOver(
      [
        { id: 'z1', name: 'example.com' },
        { id: 'z2', name: 'example.dev' },
      ],
      posts,
    );

    await expect(publish({}, ctx)).rejects.toThrow(/pass zone/);
    await expect(publish({}, ctx)).rejects.toThrow(
      /example\.com, example\.dev/,
    );
    expect(posts).toEqual([]);
  });

  it('publishes exactly the zone it was given', async () => {
    const posts: string[] = [];
    const ctx = ctxOver(
      [
        { id: 'z1', name: 'example.com' },
        { id: 'z2', name: 'example.dev' },
      ],
      posts,
    );

    await publish({ zone: 'example.dev' }, ctx);

    expect(posts).toEqual(['/clusters/c1/dns-zone/z2/wildcard']);
  });

  it('names the assigned zones when it is given one that is not among them', async () => {
    const posts: string[] = [];
    const ctx = ctxOver([{ id: 'z1', name: 'example.com' }], posts);

    await expect(publish({ zone: 'elsewhere.com' }, ctx)).rejects.toThrow(
      /No zone "elsewhere.com".*example\.com/,
    );
    expect(posts).toEqual([]);
  });

  it('says why there is nothing to publish on a cluster with no zone', async () => {
    const posts: string[] = [];
    const ctx = ctxOver([], posts);

    await expect(publish({}, ctx)).rejects.toThrow(/no DNS zone assigned/);
    expect(posts).toEqual([]);
  });
});
