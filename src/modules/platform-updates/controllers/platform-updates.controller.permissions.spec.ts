jest.mock('@kubernetes/client-node', () => ({}));

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformUpdatesController } from './platform-updates.controller';
import { K3sUpgradeController } from './k3s-upgrade.controller';
import { PermissionsGuard } from '../../iam/guards/permissions.guard';
import { REQUIRED_PERMISSION_KEY } from '../../iam/decorators/require-permission.decorator';
import { REQUIRED_SECTION_KEY } from '../../iam/decorators/require-section.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { BUILTIN_ROLES, IAM_ROLE } from '../../iam/constants/iam-roles';
import { SECTION, SECTIONS } from '../../iam/constants/iam-sections';
import { PolicyEngine } from '../../iam/interfaces/policy-engine.interface';
import { ACTION_CYCLE_KEY } from '../../action-cycle/action-cycle.decorator';
import { ALL_TOOLS } from '../../mcp/tools/tool-registry';

type Handler = (...args: never[]) => unknown;

const ROUTES: Array<[string, Handler]> = [
  ['POST /platform/updates/plan', PlatformUpdatesController.prototype.plan],
  ['POST /platform/updates', PlatformUpdatesController.prototype.start],
  [
    'POST /platform/updates/:id/resume',
    PlatformUpdatesController.prototype.resume,
  ],
  [
    'POST /platform/updates/manifests/plan',
    PlatformUpdatesController.prototype.planManifests,
  ],
  [
    'POST /platform/updates/manifests/apply',
    PlatformUpdatesController.prototype.applyManifests,
  ],
  ['GET /platform/updates/k3s/plan', K3sUpgradeController.prototype.plan],
];

function policyFor(role: keyof typeof BUILTIN_ROLES): PolicyEngine {
  const held = new Set<string>(BUILTIN_ROLES[role].permissions);
  return {
    check: jest.fn((_p: unknown, permission: string) =>
      Promise.resolve(held.has(permission)),
    ),
  } as unknown as PolicyEngine;
}

function contextFor(handler: Handler, controller: unknown): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'POST',
        user: { userId: 'u1', email: 'someone@example.com', roles: {} },
      }),
    }),
  } as unknown as ExecutionContext;
}

const infrastructureGate = SECTIONS.find(
  (s) => s.key === SECTION.INFRASTRUCTURE,
)?.gate as { permission: string };

describe('who may update the platform', () => {
  const reflector = new Reflector();

  it.each(ROUTES)('%s asks for platform:update', (_route, handler) => {
    expect(reflector.get(REQUIRED_PERMISSION_KEY, handler)).toBe(
      IAM_PERMISSION.PLATFORM_UPDATE,
    );
  });

  it('keeps both controllers inside the infrastructure section', () => {
    expect(reflector.get(REQUIRED_SECTION_KEY, PlatformUpdatesController)).toBe(
      SECTION.INFRASTRUCTURE,
    );
    expect(reflector.get(REQUIRED_SECTION_KEY, K3sUpgradeController)).toBe(
      SECTION.INFRASTRUCTURE,
    );
  });

  it('opens the section to a platform operator and not to an application operator', () => {
    const gate = infrastructureGate.permission;
    expect(BUILTIN_ROLES[IAM_ROLE.PLATFORM_OPERATOR].permissions).toContain(
      gate,
    );
    expect(BUILTIN_ROLES[IAM_ROLE.OPERATOR].permissions).not.toContain(gate);
  });

  it.each(ROUTES)('%s admits a platform operator', async (_route, handler) => {
    const guard = new PermissionsGuard(
      reflector,
      policyFor(IAM_ROLE.PLATFORM_OPERATOR),
    );
    const controller =
      handler === K3sUpgradeController.prototype.plan
        ? K3sUpgradeController
        : PlatformUpdatesController;
    await expect(
      guard.canActivate(contextFor(handler, controller)),
    ).resolves.toBe(true);
  });

  it.each(ROUTES)(
    '%s refuses a role that only operates applications',
    async (_route, handler) => {
      const guard = new PermissionsGuard(
        reflector,
        policyFor(IAM_ROLE.OPERATOR),
      );
      const controller =
        handler === K3sUpgradeController.prototype.plan
          ? K3sUpgradeController
          : PlatformUpdatesController;
      await expect(
        guard.canActivate(contextFor(handler, controller)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('asks a person before applying or resuming an update, and not before planning one', () => {
    expect(
      reflector.get(
        ACTION_CYCLE_KEY,
        PlatformUpdatesController.prototype.start,
      ),
    ).toMatchObject({ action: 'POST /platform/updates' });
    expect(
      reflector.get(
        ACTION_CYCLE_KEY,
        PlatformUpdatesController.prototype.resume,
      ),
    ).toMatchObject({
      action: 'POST /platform/updates/:id/resume',
      bind: ['id'],
    });
    expect(
      reflector.get(ACTION_CYCLE_KEY, PlatformUpdatesController.prototype.plan),
    ).toBeUndefined();
  });

  it.each([
    'POST /platform/updates/manifests/apply',
    'POST /platform/updates/reconcile-declared',
    'POST /platform/updates/manifests/values/apply',
  ])('offers %s to no agent tool', (route) => {
    const tools = ALL_TOOLS.filter((t) => t.routes?.includes(route));
    expect(tools.map((t) => t.name)).toEqual([]);
  });
});
