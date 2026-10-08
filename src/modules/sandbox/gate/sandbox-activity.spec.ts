import { SandboxActivityService } from './sandbox-activity';

describe('SandboxActivityService', () => {
  it('writes the action, clears the warning, and no more than once a minute', async () => {
    const updates: Array<{ where: unknown; set: Record<string, unknown> }> = [];
    const service = new SandboxActivityService({
      update: async (where: unknown, set: Record<string, unknown>) => {
        updates.push({ where, set });
      },
    } as never);
    const t0 = new Date('2026-10-07T12:00:00Z');

    await service.touch('u1', t0);
    await service.touch('u1', new Date(t0.getTime() + 30_000));
    await service.touch('u1', new Date(t0.getTime() + 61_000));

    expect(updates).toHaveLength(2);
    expect(updates[0].set).toEqual({ lastActiveAt: t0, expiryWarnedAt: null });
  });
});
