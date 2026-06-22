import { SetMetadata } from '@nestjs/common';

export const REQUIRED_SECTION_KEY = 'iam:requiredSection';

// Gate a route on a portal section (enforced by the global SectionAccessGuard).
export const RequireSection = (section: string) =>
  SetMetadata(REQUIRED_SECTION_KEY, section);
