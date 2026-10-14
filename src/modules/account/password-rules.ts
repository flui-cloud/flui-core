import { PasswordComplexity } from '../oidc/services/oidc-account.client';

export type PasswordRule =
  | 'min-length'
  | 'uppercase'
  | 'lowercase'
  | 'number'
  | 'symbol';

export interface PasswordRequirement {
  rule: PasswordRule;
  label: string;
}

/** The policy as a list a person can read and tick off. */
export function passwordRequirements(
  policy: PasswordComplexity,
): PasswordRequirement[] {
  const out: PasswordRequirement[] = [];
  if (policy.minLength > 0) {
    out.push({
      rule: 'min-length',
      label: `At least ${policy.minLength} characters`,
    });
  }
  if (policy.requiresUppercase) {
    out.push({ rule: 'uppercase', label: 'An uppercase letter' });
  }
  if (policy.requiresLowercase) {
    out.push({ rule: 'lowercase', label: 'A lowercase letter' });
  }
  if (policy.requiresNumber) out.push({ rule: 'number', label: 'A number' });
  if (policy.requiresSymbol) out.push({ rule: 'symbol', label: 'A symbol' });
  return out;
}

const MET: Record<
  PasswordRule,
  (pw: string, p: PasswordComplexity) => boolean
> = {
  'min-length': (pw, p) => [...pw].length >= p.minLength,
  uppercase: (pw) => /\p{Lu}/u.test(pw),
  lowercase: (pw) => /\p{Ll}/u.test(pw),
  number: (pw) => /\p{Nd}/u.test(pw),
  symbol: (pw) => /[^\p{L}\p{Nd}]/u.test(pw),
};

export function unmetRequirements(
  password: string,
  policy: PasswordComplexity,
): PasswordRequirement[] {
  return passwordRequirements(policy).filter(
    (r) => !MET[r.rule](password, policy),
  );
}
