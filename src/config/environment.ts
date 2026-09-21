/**
 * Which Flui this is, said out loud rather than inferred.
 *
 * A name and not a boolean. `isStaging` could only ever mean "not production",
 * so a fourth kind of installation would need a second flag — and, worse, a
 * boolean is false when nobody set it, which makes a misconfigured staging look
 * exactly like production.
 *
 * So the rule runs the other way: anything that has not declared itself
 * `production` is marked, including an installation that declared nothing. It
 * errs towards a badge nobody needed rather than towards a stage that passes
 * for the real thing.
 */
export const FLUI_ENVIRONMENTS = [
  'production',
  'staging',
  'preview',
  'development',
] as const;

export type FluiEnvironment = (typeof FLUI_ENVIRONMENTS)[number];

/** What a person is shown. Absent for production, which needs no label. */
export const ENVIRONMENT_LABELS: Record<FluiEnvironment, string> = {
  production: '',
  staging: 'Staging',
  preview: 'Preview',
  development: 'Development',
};

/** The label for an installation that declared nothing recognisable. */
export const UNDECLARED_ENVIRONMENT_LABEL = 'Unverified environment';

export function isFluiEnvironment(value: unknown): value is FluiEnvironment {
  return (
    typeof value === 'string' &&
    (FLUI_ENVIRONMENTS as readonly string[]).includes(value)
  );
}

/**
 * Read a declared environment, or null when there is nothing to trust.
 *
 * Null is not "production": the caller is expected to mark it, which is what
 * makes a forgotten setting visible instead of silent.
 */
export function readEnvironment(
  value: string | undefined | null,
): FluiEnvironment | null {
  const name = value?.trim().toLowerCase();
  return isFluiEnvironment(name) ? name : null;
}

export interface EnvironmentBadge {
  /** False only for an installation that declared itself production. */
  readonly show: boolean;
  readonly label: string;
}

/** What to draw, from whatever the surface was configured with. */
export function environmentBadge(
  value: string | undefined | null,
): EnvironmentBadge {
  const declared = readEnvironment(value);
  if (declared === 'production') return { show: false, label: '' };
  return {
    show: true,
    label: declared
      ? ENVIRONMENT_LABELS[declared]
      : UNDECLARED_ENVIRONMENT_LABEL,
  };
}
