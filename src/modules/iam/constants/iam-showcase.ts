import { IamSelector } from '../interfaces/iam.types';
import { IAM_ROLE, IamRole } from './iam-roles';

/**
 * The tag that puts an application in the shared showcase.
 *
 * A showcase application is one the platform's own operators run and that other
 * people are shown — the demo app that has been generating its own traffic for
 * weeks, the analytics for the public site, a heavy catalogue install nobody on
 * a demo tenancy could afford to start themselves. It is a claim about the
 * application, made by whoever tagged it; nothing infers it.
 *
 * Read-only for everyone it is shown to, and that is not a UI decision: the
 * grant below carries `viewer`, so write permissions are never in the set to
 * begin with. Showing something is not the same as lending it out.
 */
export const SHOWCASE_TAG = 'showcase';

/**
 * The grant that makes the showcase visible to a principal.
 *
 * The selector follows the tag, so an application joins or leaves the showcase
 * by being retagged and no grant is ever rewritten. The role is
 * `showcase_viewer` rather than `viewer` for the reason given where it is
 * defined: `viewer` carries `cluster:read` as well, and that is more than
 * "you may look at these".
 */
export const SHOWCASE_GRANT: { role: IamRole; selector: IamSelector } = {
  role: IAM_ROLE.SHOWCASE_VIEWER,
  selector: { tags: [SHOWCASE_TAG] },
};

export const isShowcase = (
  tags: readonly string[] | null | undefined,
): boolean => !!tags?.includes(SHOWCASE_TAG);
