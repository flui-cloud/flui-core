jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InfrastructureOperationsController } from './infrastructure-operations.controller';
import { InstallLogService } from './services/install-log.service';
import {
  InstallLogSlice,
  installLogChunk,
  parseLogCursor,
} from './helpers/install-log-chunk.helper';
import { OperationStatus } from '../servers/entities/infrastructure-operations.entity';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';

const running = { id: 'op-1', status: OperationStatus.IN_PROGRESS };
const finished = { id: 'op-1', status: OperationStatus.COMPLETED };

const slice = (over: Partial<InstallLogSlice> = {}): InstallLogSlice => ({
  text: 'abc',
  from: 0,
  total: 3,
  truncated: false,
  ...over,
});

describe('reading a node install log from a cursor', () => {
  it('hands back the cursor where this piece ended', () => {
    const chunk = installLogChunk(running, slice(), 0);
    expect(chunk).toMatchObject({
      text: 'abc',
      since: 0,
      next: 3,
      more: false,
      captured: true,
      done: false,
      note: null,
    });
  });

  it('says more is waiting when the piece stopped short of the end', () => {
    const chunk = installLogChunk(
      finished,
      slice({ text: 'ab', total: 10 }),
      0,
    );
    expect(chunk.next).toBe(2);
    expect(chunk.more).toBe(true);
    expect(chunk.done).toBe(false);
  });

  it('is done only once the operation finished and the end was read', () => {
    expect(
      installLogChunk(finished, slice({ text: '', from: 3 }), 3),
    ).toMatchObject({ next: 3, more: false, done: true });
  });

  it('counts characters the way the database does, not UTF-16 units', () => {
    const chunk = installLogChunk(
      running,
      slice({ text: '🚀ok', total: 3 }),
      0,
    );
    expect(chunk.next).toBe(3);
    expect(chunk.more).toBe(false);
  });

  it('says nothing was captured yet while the node installs', () => {
    const chunk = installLogChunk(running, null, 0);
    expect(chunk).toMatchObject({ captured: false, done: false, text: '' });
    expect(chunk.note).toContain('Nothing captured yet');
  });

  it('says honestly when a finished operation never had a log', () => {
    const chunk = installLogChunk(
      { id: 'op-1', status: OperationStatus.FAILED },
      null,
      0,
    );
    expect(chunk).toMatchObject({ captured: false, done: true });
    expect(chunk.note).toContain('No install log was captured');
  });

  it('says the log was cut at its size limit once the end is reached', () => {
    const chunk = installLogChunk(
      running,
      slice({ text: '', from: 3, truncated: true }),
      3,
    );
    expect(chunk.note).toContain('size limit');
  });

  it('resumes from the end when the cursor was past it', () => {
    const chunk = installLogChunk(running, slice({ text: '', from: 3 }), 99);
    expect(chunk.since).toBe(3);
    expect(chunk.next).toBe(3);
    expect(chunk.note).toContain('past the end');
  });

  it('accepts no cursor as the start and refuses a nonsense one', () => {
    expect(parseLogCursor(undefined)).toBe(0);
    expect(parseLogCursor('42')).toBe(42);
    expect(() => parseLogCursor('-1')).toThrow(BadRequestException);
    expect(() => parseLogCursor('1.5')).toThrow(BadRequestException);
    expect(() => parseLogCursor('abc')).toThrow(BadRequestException);
  });
});

describe('InstallLogService.readSlice', () => {
  const build = (raw: unknown) => {
    const qb: Record<string, jest.Mock> = {};
    for (const m of ['select', 'addSelect', 'where', 'setParameters']) {
      qb[m] = jest.fn().mockReturnValue(qb);
    }
    qb.getRawOne = jest.fn().mockResolvedValue(raw);
    const repository = { createQueryBuilder: jest.fn(() => qb) };
    const service = new InstallLogService(repository as never, {} as never);
    return { service, qb };
  };

  it('reads length and piece in one statement, one-based in the database', async () => {
    const { service, qb } = build({
      total: '120',
      truncated: false,
      text: 'x',
    });
    await expect(service.readSlice('op-1', 100, 10)).resolves.toEqual({
      text: 'x',
      from: 100,
      total: 120,
      truncated: false,
    });
    expect(qb.getRawOne).toHaveBeenCalledTimes(1);
    expect(qb.setParameters).toHaveBeenCalledWith({ start: 101, limit: 10 });
  });

  it('clamps a cursor past the end to the end', async () => {
    const { service } = build({ total: 5, truncated: true, text: '' });
    await expect(service.readSlice('op-1', 50, 10)).resolves.toMatchObject({
      from: 5,
      truncated: true,
    });
  });

  it('answers null when nothing was captured', async () => {
    const { service } = build(undefined);
    await expect(service.readSlice('op-1', 0, 10)).resolves.toBeNull();
  });
});

describe('GET /infrastructure/operations/:id/log/chunk', () => {
  const person: AuthenticatedUser = {
    userId: 'user-a',
    email: 'a@example.com',
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
  };

  const build = (owner: string) => {
    const service = {
      getOperationDetails: jest.fn().mockResolvedValue({
        id: 'op-1',
        userId: owner,
        status: OperationStatus.IN_PROGRESS,
      }),
    };
    const installLogService = {
      readSlice: jest.fn().mockResolvedValue(slice({ from: 1, text: 'bc' })),
    };
    const policy = { resolveSectionAccess: jest.fn().mockResolvedValue([]) };
    const controller = new InfrastructureOperationsController(
      service as never,
      installLogService as never,
      policy as never,
    );
    return { controller, installLogService };
  };

  it('reads from the cursor for whoever started the operation', async () => {
    const { controller, installLogService } = build('user-a');
    await expect(
      controller.readLogChunk('op-1', '1', { user: person } as never),
    ).resolves.toMatchObject({ text: 'bc', since: 1, next: 3 });
    expect(installLogService.readSlice).toHaveBeenCalledWith(
      'op-1',
      1,
      expect.any(Number),
    );
  });

  it('refuses someone else with the 404 a missing id gets', async () => {
    const { controller, installLogService } = build('someone-else');
    await expect(
      controller.readLogChunk('op-1', undefined, { user: person } as never),
    ).rejects.toThrow(NotFoundException);
    expect(installLogService.readSlice).not.toHaveBeenCalled();
  });
});
