import { SandboxGuestEnrolmentService } from './sandbox-guest-enrolment';
import { loadSandboxConfig } from '../sandbox.config';

describe('SandboxGuestEnrolmentService', () => {
  const build = (
    existing: Array<{ principalType: string; principalRef: string }>,
    enabled = true,
  ) => {
    const saved: Array<Record<string, unknown>> = [];
    const bindings = {
      exists: async ({
        where,
      }: {
        where: { principalType: string; principalRef: string };
      }) =>
        existing.some(
          (b) =>
            b.principalType === where.principalType &&
            b.principalRef === where.principalRef,
        ),
      create: (b: Record<string, unknown>) => b,
      save: async (rows: Array<Record<string, unknown>>) => {
        saved.push(...rows);
        return rows;
      },
    };
    const service = new SandboxGuestEnrolmentService(
      bindings as never,
      loadSandboxConfig(enabled ? { SANDBOX_ENABLED: 'true' } : {}),
    );
    return { service, saved };
  };

  const person = {
    userId: 'u1',
    email: 'mario@example.com',
    hasProviderRoles: false,
  };

  it('makes a new person on a demo instance a guest, fenced to what they own, by id', async () => {
    const { service, saved } = build([]);

    expect(await service.enrol(person)).toBe(true);
    expect(saved).toEqual([
      expect.objectContaining({
        principalRef: 'u1',
        role: 'sandbox',
        selector: { owner: 'u1' },
      }),
      expect.objectContaining({ principalRef: 'u1', role: 'showcase_viewer' }),
    ]);
  });

  it('does nothing on an installation that is not a demo', async () => {
    const { service, saved } = build([], false);

    expect(await service.enrol(person)).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it('leaves alone a person the operator invited by address', async () => {
    const { service, saved } = build([
      { principalType: 'user', principalRef: 'mario@example.com' },
    ]);

    expect(await service.enrol(person)).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it('leaves alone a person the identity provider already gave a role', async () => {
    const { service } = build([]);

    expect(await service.enrol({ ...person, hasProviderRoles: true })).toBe(
      false,
    );
  });

  it('never enrols the same person twice', async () => {
    const { service, saved } = build([
      { principalType: 'user', principalRef: 'u1' },
    ]);

    expect(await service.enrol(person)).toBe(false);
    expect(saved).toHaveLength(0);
  });
});
