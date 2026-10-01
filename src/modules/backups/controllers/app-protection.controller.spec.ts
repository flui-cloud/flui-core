jest.mock('@kubernetes/client-node', () => ({}));

import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AppProtectionController } from './app-protection.controller';
import {
  APP_ACTION_KEY,
  AppAccessGuard,
} from '../../applications/guards/app-access.guard';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  ACTION_CYCLE_KEY,
  ActionCycleDecl,
} from '../../action-cycle/action-cycle.decorator';
import { composeSentence } from '../../action-cycle/action-cycle.core';
import { SetBackupDecisionDto } from '../dto/set-backup-decision.dto';
import { NOTE_MAX } from '../utils/app-backup-decision.rules';

const handler = AppProtectionController.prototype.setBackupDecision;

describe('PUT /applications/:id/backup-decision', () => {
  it('needs the right to change that application', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AppProtectionController),
    ).toContain(AppAccessGuard);
    expect(Reflect.getMetadata(APP_ACTION_KEY, handler)).toBe(
      IAM_PERMISSION.APP_WRITE,
    );
  });

  it('asks a person before an agent decides, saying what it does', () => {
    const decl = Reflect.getMetadata(
      ACTION_CYCLE_KEY,
      handler,
    ) as ActionCycleDecl;
    expect(decl).toMatchObject({
      action: 'PUT /applications/:id/backup-decision',
      bind: ['id'],
      consequence:
        'Flui stops asking for a backup of this application; nothing already taken is deleted.',
    });
    expect(
      composeSentence(decl.sentence, { id: 'a1' }, decl.clause, {
        notBackedUp: false,
      }),
    ).toBe('decide that application a1 is not backed up — back it up again');
  });

  it('hands the caller to the service as the person who decided', async () => {
    const decisions = {
      set: jest.fn(async () => ({ applicationId: 'a1', decision: null })),
    };
    const controller = new AppProtectionController(
      {} as never,
      {} as never,
      decisions as never,
    );
    const user = { userId: 'u1', email: 'd@example.com' };
    await controller.setBackupDecision({ user } as never, 'a1', {
      notBackedUp: true,
      note: 'scratch',
    });
    expect(decisions.set).toHaveBeenCalledWith(
      'a1',
      { notBackedUp: true, note: 'scratch' },
      user,
    );
  });
});

describe('SetBackupDecisionDto', () => {
  const errors = (body: unknown) =>
    validate(plainToInstance(SetBackupDecisionDto, body));

  it('takes a yes or no and an optional short note', async () => {
    expect(await errors({ notBackedUp: true })).toHaveLength(0);
    expect(await errors({ notBackedUp: false, note: 'why' })).toHaveLength(0);
  });

  it('refuses a missing answer, a note that is not text, and one too long', async () => {
    expect(await errors({})).not.toHaveLength(0);
    expect(await errors({ notBackedUp: 'yes' })).not.toHaveLength(0);
    expect(await errors({ notBackedUp: true, note: 3 })).not.toHaveLength(0);
    expect(
      await errors({ notBackedUp: true, note: 'x'.repeat(NOTE_MAX + 1) }),
    ).not.toHaveLength(0);
  });
});
