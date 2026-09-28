jest.mock('../../mail/services/mail-send.service', () => ({
  MailSendService: class MailSendService {},
}));

import { REQUIRED_SECTION_KEY } from '../../iam/decorators/require-section.decorator';
import { REQUIRED_PERMISSION_KEY } from '../../iam/decorators/require-permission.decorator';
import { SECTION } from '../../iam/constants/iam-sections';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ACTION_CYCLE_KEY } from '../../action-cycle/action-cycle.decorator';
import { AlertDestinationsController } from './alert-destinations.controller';

const handler = (name: keyof AlertDestinationsController) =>
  AlertDestinationsController.prototype[name] as unknown as object;

const permissionOf = (name: keyof AlertDestinationsController) =>
  Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler(name));

const cycleOf = (name: keyof AlertDestinationsController) =>
  Reflect.getMetadata(ACTION_CYCLE_KEY, handler(name));

describe('AlertDestinationsController — who may do what', () => {
  it('sits behind the infrastructure section', () => {
    expect(
      Reflect.getMetadata(REQUIRED_SECTION_KEY, AlertDestinationsController),
    ).toBe(SECTION.INFRASTRUCTURE);
  });

  it.each(['list', 'getAdmins'] as const)('reads %s with cluster:read', (m) => {
    expect(permissionOf(m)).toBe(IAM_PERMISSION.CLUSTER_READ);
  });

  it.each(['create', 'update', 'remove', 'test', 'setAdmins'] as const)(
    'writes %s with cluster:manage',
    (m) => {
      expect(permissionOf(m)).toBe(IAM_PERMISSION.CLUSTER_MANAGE);
    },
  );

  it('makes an agent ask before adding, removing or testing a destination', () => {
    expect(cycleOf('create')?.action).toBe(
      'POST /observability/alert-destinations',
    );
    expect(cycleOf('remove')).toEqual(
      expect.objectContaining({
        action: 'DELETE /observability/alert-destinations/:id',
        bind: ['id'],
      }),
    );
    expect(cycleOf('test')).toEqual(
      expect.objectContaining({
        action: 'POST /observability/alert-destinations/:id/test',
        bind: ['id'],
      }),
    );
    expect(cycleOf('list')).toBeUndefined();
  });

  it('hands the caller’s email to the service as the creator', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'd1' });
    const controller = new AlertDestinationsController({ create } as never);
    await controller.create({ kind: 'email', target: 'oncall@example.com' }, {
      user: { userId: 'u1', email: 'ops@example.com' },
    } as never);
    expect(create).toHaveBeenCalledWith(
      { kind: 'email', target: 'oncall@example.com' },
      'ops@example.com',
      { userId: 'u1', email: 'ops@example.com' },
    );
  });
});
