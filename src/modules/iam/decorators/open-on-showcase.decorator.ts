import { SetMetadata } from '@nestjs/common';

export const OPEN_ON_SHOWCASE_KEY = 'iam:openOnShowcase';

/**
 * A data door that stays open on an application in the showcase: reading it
 * there needs `app:read`, not `data:access`. Only for reads the operator puts
 * on display by publishing (logs, crash diagnoses, and the SQL console as a
 * role that can only SELECT); environment, sources, other consoles and shells
 * keep asking for `data:access` everywhere.
 */
export const OpenOnShowcase = () => SetMetadata(OPEN_ON_SHOWCASE_KEY, true);
