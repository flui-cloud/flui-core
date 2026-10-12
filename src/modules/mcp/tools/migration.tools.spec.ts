import { MIGRATION_TOOLS } from './migration.tools';
import { McpToolContext, ToolDef } from './mcp-tool.util';

const tool = (name: string) =>
  MIGRATION_TOOLS.find((t) => t.name === name) as ToolDef;

function ctx(posts: { path: string; body: unknown }[]): McpToolContext {
  return {
    api: {
      post: jest.fn(async (path: string, body: unknown) => {
        posts.push({ path, body });
        return { id: 'm1', status: 'pending' };
      }),
    },
  } as unknown as McpToolContext;
}

describe('migration tools and the bridge', () => {
  it('passes the backup destination of a full move to the API', async () => {
    const posts: { path: string; body: unknown }[] = [];

    await tool('migrate_full').run(
      {
        appId: 'a1',
        dbAppId: 'd1',
        targetClusterId: 'c2',
        backupDestinationId: 'dest-1',
      } as never,
      ctx(posts),
    );

    expect(posts[0]).toEqual({
      path: '/full-migrations',
      body: expect.objectContaining({ backupDestinationId: 'dest-1' }),
    });
  });

  it('passes the choice to skip the bridge to the API', async () => {
    const posts: { path: string; body: unknown }[] = [];

    await tool('migrate_app').run(
      { srcAppId: 'a1', targetClusterId: 'c2', bridge: false } as never,
      ctx(posts),
    );

    expect(posts[0]).toEqual({
      path: '/app-migrations',
      body: expect.objectContaining({ bridge: false }),
    });
  });

  it('asks to close the bridge now only when told to', async () => {
    const posts: { path: string; body: unknown }[] = [];

    await tool('migration_destroy_source').run(
      { type: 'app', id: 'm1', closeBridge: true } as never,
      ctx(posts),
    );

    expect(posts[0]).toEqual({
      path: '/app-migrations/m1/destroy-source',
      body: { closeBridge: true },
    });
  });

  it("shows the model the API's bridge block", () => {
    const bridge = { mode: 'bridge', state: 'active', readyToClose: false };
    const view = tool('migration_get').forModel?.({
      id: 'm1',
      status: 'bridging',
      bridge,
    }) as Record<string, unknown>;

    expect(view.bridge).toEqual(bridge);
  });

  it('tells the model when an interrupted cutover can be resumed', () => {
    const view = tool('migration_get').forModel?.({
      id: 'm1',
      status: 'cutover',
      canResumeCutover: true,
    }) as Record<string, unknown>;

    expect(view.canResumeCutover).toBe(true);
  });
});

describe('migration tools and the pooler pause', () => {
  it('passes the pause deadline of a full move and of its cutover to the API', async () => {
    const posts: { path: string; body: unknown }[] = [];
    await tool('migrate_full').run(
      {
        appId: 'a1',
        dbAppId: 'd1',
        targetClusterId: 'c2',
        pauseDeadlineSeconds: 10,
      } as never,
      ctx(posts),
    );
    await tool('migration_cutover').run(
      { type: 'full', id: 'm1', pauseDeadlineSeconds: 20 } as never,
      ctx(posts),
    );
    await tool('migration_cutover').run(
      { type: 'full', id: 'm2' } as never,
      ctx(posts),
    );
    expect(posts[0].body).toEqual(
      expect.objectContaining({ pauseDeadlineSeconds: 10 }),
    );
    expect(posts[1]).toEqual({
      path: '/full-migrations/m1/cutover',
      body: { pauseDeadlineSeconds: 20 },
    });
    expect(posts[2].body).toEqual({});
  });

  it('refuses a pause deadline on a migration that has no poolers to pause', async () => {
    const posts: { path: string; body: unknown }[] = [];
    await expect(
      Promise.resolve().then(() =>
        tool('migration_cutover').run(
          { type: 'app', id: 'm1', pauseDeadlineSeconds: 5 } as never,
          ctx(posts),
        ),
      ),
    ).rejects.toThrow(/full migration only/);
    expect(posts).toEqual([]);
  });

  it('shows the model the pooler block', () => {
    const pooler = {
      paused: false,
      pausedAt: 't0',
      resumedAt: 't1',
      resumedBy: 'retarget',
      sourceLeftPaused: true,
      deadlineMs: 5000,
      cut: [{ clientApp: 'worker', heldMs: 6100 }],
    };
    const view = tool('migration_get').forModel?.({
      id: 'm1',
      pooler,
    }) as Record<string, unknown>;
    expect(view.pooler).toEqual(pooler);
  });
});
