import { ForbiddenException } from '@nestjs/common';
import { ActionCycleService } from './action-cycle.service';
import { ActionCycleDecl } from './action-cycle.decorator';
import {
  ALWAYS_ASK_ACTIONS,
  PROPOSAL_DECISION,
  PROPOSAL_STATUS,
} from './action-cycle.core';

const REMOVE: ActionCycleDecl = {
  action: 'DELETE /applications/:id/install',
  bind: ['id'],
  sentence: 'remove application {id} for good',
};

function service(opts: {
  concessions?: unknown[];
  proposal?: Record<string, unknown> | null;
}) {
  const saved: Record<string, unknown>[] = [];
  const proposals = {
    findOne: jest.fn().mockResolvedValue(opts.proposal ?? null),
    create: (p: Record<string, unknown>) => ({ ...p }),
    save: jest.fn((p: Record<string, unknown>) => {
      const row = { id: 'p1', ...p };
      saved.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  const concessions = {
    find: jest.fn().mockResolvedValue(opts.concessions ?? []),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const svc = new ActionCycleService(
    proposals as never,
    concessions as never,
    {} as never,
    { get: () => 'https://console.test' } as never,
  );
  return { svc, saved, concessions };
}

const attempt = {
  decl: REMOVE,
  ownerUserId: 'u1',
  keyId: 'k1',
  method: 'DELETE',
  path: '/applications/a1/install',
  params: { id: 'a1' },
};

describe('an action a person answers every time', () => {
  it('lists the removal tools and the routes that widen a key', () => {
    expect(ALWAYS_ASK_ACTIONS.has('DELETE /applications/:id/install')).toBe(
      true,
    );
    expect(ALWAYS_ASK_ACTIONS.has('PATCH /auth/api-keys/:id/scopes')).toBe(
      true,
    );
    expect(ALWAYS_ASK_ACTIONS.has('POST /applications/:id/deploy')).toBe(false);
  });

  it('asks again even where an "always" was granted before', async () => {
    const standing = {
      id: 'c1',
      keyId: 'k1',
      ownerUserId: 'u1',
      action: REMOVE.action,
      binding: { id: 'a1' },
      revokedAt: null,
    };
    const { svc, saved, concessions } = service({ concessions: [standing] });

    await expect(svc.authorize(attempt)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(concessions.find).not.toHaveBeenCalled();
    expect(saved[0]?.offersAlways).toBe(false);
  });

  it('refuses "always" on a request raised before the action joined the list', async () => {
    const { svc } = service({
      proposal: {
        id: 'p1',
        ownerUserId: 'u1',
        action: REMOVE.action,
        status: PROPOSAL_STATUS.PENDING,
        offersAlways: true,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await expect(
      svc.decideProposal('p1', 'u1', PROPOSAL_DECISION.ALWAYS),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
