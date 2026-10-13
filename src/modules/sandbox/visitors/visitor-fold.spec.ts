import { UserEntity } from '../../auth/entities/user.entity';
import { ApiKeyEntity } from '../../auth/entities/api-key.entity';
import { IamRoleBindingEntity } from '../../iam/entities/iam-role-binding.entity';
import { InferenceUsageEventEntity } from '../../inference/entities/inference-usage-event.entity';
import { ActionProposalEntity } from '../../action-cycle/entities/action-proposal.entity';
import { AgentConcessionEntity } from '../../action-cycle/entities/agent-concession.entity';
import { SandboxGuestEnrolmentService } from '../gate/sandbox-guest-enrolment';
import { loadSandboxConfig } from '../sandbox.config';
import { SandboxVisitorEntity } from '../entities/sandbox-visitor.entity';
import { flipVisitorToPerson, foldVisitorInto } from './visitor-fold';

type Binding = { principalType: string; principalRef: string; role?: string };

const fakeManager = (bindings: Binding[]) => {
  const calls: Array<[string, string, unknown, unknown?]> = [];
  const repo = (name: string) => ({
    save: jest.fn(async (row: unknown) => {
      calls.push([name, 'save', row]);
      if (name === 'bindings') bindings.push(...(row as Binding[]));
      return row;
    }),
    create: (row: unknown) => row,
    update: jest.fn(async (where: unknown, set: unknown) => {
      calls.push([name, 'update', where, set]);
      return { affected: 1 };
    }),
    delete: jest.fn(async (where: Record<string, string>) => {
      calls.push([name, 'delete', where]);
      if (name === 'bindings') {
        for (let i = bindings.length - 1; i >= 0; i--) {
          if (bindings[i].principalRef === where.principalRef) {
            bindings.splice(i, 1);
          }
        }
      }
      return { affected: 1 };
    }),
    exists: jest.fn(
      async ({ where }: { where: Binding }) =>
        name === 'bindings' &&
        bindings.some((b) => b.principalRef === where.principalRef),
    ),
  });
  const names = new Map<unknown, string>([
    [UserEntity, 'users'],
    [ApiKeyEntity, 'keys'],
    [IamRoleBindingEntity, 'bindings'],
    [InferenceUsageEventEntity, 'usage'],
    [ActionProposalEntity, 'proposals'],
    [AgentConcessionEntity, 'concessions'],
    [SandboxVisitorEntity, 'visitors'],
  ]);
  const repos = new Map<string, ReturnType<typeof repo>>();
  const manager = {
    getRepository: (entity: unknown) => {
      const name = names.get(entity) ?? 'unknown';
      if (!repos.has(name)) repos.set(name, repo(name));
      return repos.get(name)!;
    },
  };
  return { manager, calls };
};

const visitor = (): UserEntity =>
  ({
    id: 'v1',
    email: 'visitor-1a2b3c4d@visitors.invalid',
    kind: 'visitor',
    displayName: 'Visitor',
    oidcSub: 'idp-v1',
  }) as UserEntity;

const enrolment = () =>
  new SandboxGuestEnrolmentService(
    {} as never,
    loadSandboxConfig({ SANDBOX_ENABLED: 'true' }),
    {} as never,
    {} as never,
  );

const NOW = new Date('2026-10-13T12:00:00Z');

describe('flipVisitorToPerson', () => {
  it('turns the visitor into a guest on the same row, with its proven address', async () => {
    const bindings: Binding[] = [
      { principalType: 'user', principalRef: 'v1', role: 'sandbox_visitor' },
      { principalType: 'user', principalRef: 'v1', role: 'showcase_viewer' },
    ];
    const { manager, calls } = fakeManager(bindings);
    const user = visitor();

    const { guest } = await flipVisitorToPerson(
      manager as never,
      enrolment(),
      user,
      {
        email: 'mario@example.com',
        firstName: 'Mario',
        lastName: 'Rossi',
        displayName: 'Mario Rossi',
      },
      NOW,
    );

    expect(guest).toBe(true);
    expect(user).toEqual(
      expect.objectContaining({
        id: 'v1',
        kind: 'person',
        email: 'mario@example.com',
        displayName: 'Mario Rossi',
        oidcSub: 'idp-v1',
      }),
    );
    expect(bindings.map((b) => b.role).sort()).toEqual([
      'sandbox',
      'showcase_viewer',
    ]);
    expect(calls).toContainEqual([
      'visitors',
      'update',
      { userId: 'v1' },
      { upgradedAt: NOW },
    ]);
    expect(calls.some(([name]) => name === 'keys')).toBe(false);
  });

  it('keeps the placeholder when the address is not proven', async () => {
    const { manager } = fakeManager([]);
    const user = visitor();

    await flipVisitorToPerson(
      manager as never,
      enrolment(),
      user,
      { email: null, firstName: null, lastName: null, displayName: null },
      NOW,
    );

    expect(user.email).toBe('visitor-1a2b3c4d@visitors.invalid');
    expect(user.kind).toBe('person');
  });

  it('does not make somebody invited by address a guest', async () => {
    const bindings: Binding[] = [
      { principalType: 'user', principalRef: 'v1', role: 'sandbox_visitor' },
      {
        principalType: 'user',
        principalRef: 'invited@example.com',
        role: 'editor',
      },
    ];
    const { manager } = fakeManager(bindings);

    const { guest } = await flipVisitorToPerson(
      manager as never,
      enrolment(),
      visitor(),
      {
        email: 'invited@example.com',
        firstName: null,
        lastName: null,
        displayName: null,
      },
      NOW,
    );

    expect(guest).toBe(false);
    expect(bindings).toEqual([
      expect.objectContaining({ principalRef: 'invited@example.com' }),
    ]);
  });
});

describe('foldVisitorInto', () => {
  it('moves what the visitor made to the account and removes the visitor, keeping its record', async () => {
    const { manager, calls } = fakeManager([]);

    await foldVisitorInto(manager as never, visitor(), 'r1', NOW);

    expect(calls).toEqual([
      ['keys', 'update', { userId: 'v1' }, { userId: 'r1' }],
      ['usage', 'update', { userId: 'v1' }, { userId: 'r1' }],
      ['proposals', 'update', { ownerUserId: 'v1' }, { ownerUserId: 'r1' }],
      ['concessions', 'update', { ownerUserId: 'v1' }, { ownerUserId: 'r1' }],
      ['bindings', 'delete', { principalType: 'user', principalRef: 'v1' }],
      [
        'visitors',
        'update',
        { userId: 'v1' },
        { upgradedAt: NOW, linkedUserId: 'r1' },
      ],
      ['users', 'delete', { id: 'v1', kind: 'visitor' }],
    ]);
  });
});
