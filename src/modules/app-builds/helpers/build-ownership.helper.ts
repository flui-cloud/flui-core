import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { PolicyEngine } from '../../iam/interfaces/policy-engine.interface';
import { mayReadOperation } from '../../infrastructure/operations/helpers/operation-ownership.helper';

/** The two columns that say whose a build is. */
export interface BuildOwnership {
  applicationId: string | null;
  operationId?: string | null;
}

/**
 * What the caller has to hand to answer the question. Passed in rather than
 * injected so that the rule can be asked from a controller, from another
 * module's WebSocket gateway, and from anywhere else, without any of them
 * importing each other.
 */
export interface BuildOwnershipLookups {
  application: (id: string) => Promise<ApplicationEntity | null>;
  canOnApplication: (
    user: AuthenticatedUser,
    action: string,
    app: ApplicationEntity,
  ) => Promise<boolean>;
  operation: (id: string) => Promise<{ userId?: string | null } | null>;
  policy: PolicyEngine;
}

/**
 * May this caller act on this build?
 *
 * Written once because it is asked from four doors — `applications/builds/:id`,
 * `builds/:id`, the `subscribe:build` room, and the standalone build the deploy
 * wizard watches — and three of them used to answer differently or not at all.
 * A build's authority is the application it belongs to; the answer is that
 * application's answer, unchanged.
 *
 * A build with no application yet is the wizard's: it exists before the
 * application does, so it has no owner to inherit from. What it does have is
 * the operation that started it, and an operation records who asked for it —
 * so the same rule the operations room and route already use decides here too.
 * A build with neither belongs to nobody and is refused to everybody but an
 * operator, which is exactly what `mayReadOperation` says about an ownerless
 * operation.
 */
export async function mayActOnBuild(
  build: BuildOwnership | null | undefined,
  user: AuthenticatedUser | undefined,
  action: string,
  lookups: BuildOwnershipLookups,
): Promise<boolean> {
  if (!build || !user) return false;
  if (user.isAdmin) return true;

  if (build.applicationId) {
    const app = await lookups.application(build.applicationId);
    if (!app) return false;
    return lookups.canOnApplication(user, action, app);
  }

  const operation = build.operationId
    ? await lookups.operation(build.operationId)
    : null;
  return mayReadOperation(lookups.policy, operation, user);
}
