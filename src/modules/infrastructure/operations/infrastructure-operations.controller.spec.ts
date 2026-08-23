jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { NotFoundException } from '@nestjs/common';
import { InfrastructureOperationsController } from './infrastructure-operations.controller';
import { InfrastructureOperationEntity } from '../servers/entities/infrastructure-operations.entity';
import { SectionAccess } from '../../iam/constants/iam-sections';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';

/**
 * The route used to take an id and nothing else: whoever passed the section
 * gate read any operation on the instance. A sandbox guest passes that gate —
 * `section:view` opens every section read-only and a GET is a safe verb — so
 * the only thing between a guest and another tenant's provisioning was the id
 * being a UUID. These tests pin the question the handler now asks instead.
 */
describe('GET /infrastructure/operations/:id asks whose operation it is', () => {
  const person = (
    over: Partial<AuthenticatedUser> = {},
  ): AuthenticatedUser => ({
    userId: 'user-a',
    email: 'a@example.com',
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
    ...over,
  });

  const build = (
    operation: Partial<InfrastructureOperationEntity>,
    sections: SectionAccess[] = [],
  ) => {
    const service = {
      getOperationDetails: jest
        .fn()
        .mockResolvedValue({ id: 'op-1', ...operation }),
    };
    const policy = {
      resolveSectionAccess: jest.fn().mockResolvedValue(sections),
    };
    return {
      service,
      policy,
      controller: new InfrastructureOperationsController(
        service as never,
        policy as never,
      ),
    };
  };

  const ask = (
    controller: InfrastructureOperationsController,
    user: AuthenticatedUser | undefined,
  ) => controller.getOperationStatus('op-1', { user } as never);

  it('answers the person who started it', async () => {
    const { controller } = build({ userId: 'user-a' });
    await expect(ask(controller, person())).resolves.toMatchObject({
      id: 'op-1',
    });
  });

  it('refuses someone else, and with the 404 a missing id gets', async () => {
    const { controller } = build({ userId: 'someone-else' });
    await expect(ask(controller, person())).rejects.toThrow(NotFoundException);
    await expect(ask(controller, person())).rejects.toThrow(
      'Operation op-1 not found',
    );
  });

  it('refuses a guest who holds the section only read-only', async () => {
    const { controller } = build({ userId: 'someone-else' }, [
      { key: 'infrastructure', level: 'read-only' },
    ]);
    await expect(ask(controller, person())).rejects.toThrow(NotFoundException);
  });

  it('answers an operator who holds the infrastructure section in full', async () => {
    const { controller } = build({ userId: 'someone-else' }, [
      { key: 'infrastructure', level: 'full' },
    ]);
    await expect(ask(controller, person())).resolves.toMatchObject({
      id: 'op-1',
    });
  });

  it('answers a platform administrator without resolving anything', async () => {
    const { controller, policy } = build({ userId: 'someone-else' });
    await expect(
      ask(controller, person({ isAdmin: true })),
    ).resolves.toMatchObject({ id: 'op-1' });
    expect(policy.resolveSectionAccess).not.toHaveBeenCalled();
  });

  it('refuses an operation with no recorded owner to everyone but an operator', async () => {
    const { controller } = build({ userId: undefined });
    await expect(ask(controller, person())).rejects.toThrow(NotFoundException);

    const operator = build({ userId: undefined }, [
      { key: 'infrastructure', level: 'full' },
    ]);
    await expect(ask(operator.controller, person())).resolves.toMatchObject({
      id: 'op-1',
    });
  });

  it('still 404s an id that does not exist at all', async () => {
    const { controller, service } = build({});
    service.getOperationDetails.mockRejectedValue(
      new NotFoundException('Operation op-1 not found'),
    );
    await expect(ask(controller, person({ isAdmin: true }))).rejects.toThrow(
      'Operation op-1 not found',
    );
  });
});
