import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

// Importing the real invite mailer drags in the credential chain and, through
// it, an ESM-only Kubernetes client Jest cannot parse. Only the DI token is
// needed here.
jest.mock('../../mail/services/invite-mail.service', () => ({
  InviteMailService: class InviteMailService {},
}));

import { UserManagementService } from './user-management.service';
import { InviteMailService } from '../../mail/services/invite-mail.service';
// Type-only: erased at compile time, so the jest.mock above still governs runtime.
import type { InviteMailOutcome } from '../../mail/services/invite-mail.service';
import { IDENTITY_DIRECTORY } from '../interfaces/identity-directory.interface';
import { UserEntity } from '../entities/user.entity';

const LINK = {
  inviteLink: 'https://auth.example.com/ui/login/user/invite?code=abc',
  inviteCode: 'abc',
  userId: 'user-1',
};

async function build(
  directory: Record<string, unknown>,
  sendInvite: jest.Mock<Promise<InviteMailOutcome>, [unknown]> = jest.fn(
    async (_i: unknown) => ({ sent: true, messageId: 'm1' }),
  ),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      UserManagementService,
      { provide: IDENTITY_DIRECTORY, useValue: directory },
      {
        provide: getRepositoryToken(UserEntity),
        useValue: { findOne: jest.fn() },
      },
      { provide: InviteMailService, useValue: { sendInvite } },
    ],
  }).compile();
  return { service: moduleRef.get(UserManagementService), sendInvite };
}

describe('createInviteLink delivery', () => {
  const directory = () => ({
    createInviteLink: jest.fn(async () => LINK),
    getUser: jest.fn(async () => ({
      id: 'user-1',
      email: 'new@example.com',
      firstName: 'Ada',
      role: 'user',
      isBootstrapAdmin: false,
      isSystemUser: false,
    })),
  });

  it('sends nothing unless asked, which keeps the old behaviour intact', async () => {
    const dir = directory();
    const { service, sendInvite } = await build(dir);

    const result = await service.createInviteLink('user-1');

    expect(result.inviteLink).toBe(LINK.inviteLink);
    expect(result.delivery).toEqual({ sent: false, reason: 'not_requested' });
    expect(sendInvite).not.toHaveBeenCalled();
    expect(dir.getUser).not.toHaveBeenCalled();
  });

  it('emails the link when asked, addressing the recipient and naming the inviter', async () => {
    const { service, sendInvite } = await build(directory());

    const result = await service.createInviteLink('user-1', {
      send: true,
      invitedBy: 'dawit',
    });

    expect(result.delivery).toEqual({ sent: true });
    expect(sendInvite).toHaveBeenCalledWith({
      to: 'new@example.com',
      inviteLink: LINK.inviteLink,
      firstName: 'Ada',
      invitedBy: 'dawit',
    });
  });

  it('still returns the link when the mail fails', async () => {
    // The link works pasted into a chat window. Withholding it because the
    // mailer is misconfigured would leave the admin worse off than before
    // email existed here at all.
    const failing: jest.Mock<Promise<InviteMailOutcome>, [unknown]> = jest.fn(
      async (_i: unknown) => ({
        sent: false,
        reason: 'send_failed',
      }),
    );
    const { service } = await build(directory(), failing);

    const result = await service.createInviteLink('user-1', { send: true });

    expect(result.inviteLink).toBe(LINK.inviteLink);
    expect(result.inviteCode).toBe('abc');
    expect(result.delivery).toEqual({ sent: false, reason: 'send_failed' });
  });

  it('says so when the user has no address to send to', async () => {
    const dir = { ...directory(), getUser: jest.fn(async () => null) };
    const { service, sendInvite } = await build(dir);

    const result = await service.createInviteLink('user-1', { send: true });

    expect(result.delivery).toEqual({ sent: false, reason: 'no_address' });
    expect(sendInvite).not.toHaveBeenCalled();
    expect(result.inviteLink).toBe(LINK.inviteLink);
  });

  it('mints exactly one link per call, because minting rotates the code', async () => {
    // A retry would hand out a link that invalidates the one already on its way.
    const dir = directory();
    const refusing: jest.Mock<Promise<InviteMailOutcome>, [unknown]> = jest.fn(
      async (_i: unknown) => ({
        sent: false,
        reason: 'send_failed',
      }),
    );
    const { service } = await build(dir, refusing);

    await service.createInviteLink('user-1', { send: true });

    expect(dir.createInviteLink).toHaveBeenCalledTimes(1);
  });
});
