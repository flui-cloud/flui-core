export const SYSTEM_HOSTNAME_APPS = [
  'flui-web',
  'flui-api',
  'zitadel',
] as const;

export type SystemHostnameApp = (typeof SYSTEM_HOSTNAME_APPS)[number];

export const DEFAULT_SYSTEM_LABELS: Record<SystemHostnameApp, string> = {
  'flui-web': 'dashboard',
  'flui-api': 'api',
  zitadel: 'auth',
};

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOSTNAME_LENGTH = 253;

export function normalizeHostnameInput(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase().replace(/\.$/, '');
}

function labelProblem(label: string): string | null {
  if (label.length > 63) return `"${label}" is longer than 63 characters.`;
  if (!DNS_LABEL.test(label)) {
    return `"${label}" can only use lowercase letters, digits and hyphens, and cannot start or end with a hyphen.`;
  }
  return null;
}

/**
 * The wildcard certificate of a zone covers `*.<zone>` and nothing deeper, so a
 * name served under it is exactly one label.
 */
export function wildcardLabelProblem(
  label: string,
  zoneName: string,
): string | null {
  if (!label) return 'Enter a name.';
  if (label.includes('.')) {
    return `Use one name without dots: the certificate for *.${zoneName} covers a single level.`;
  }
  const problem = labelProblem(label);
  if (problem) return problem;
  if (label.length + 1 + zoneName.length > MAX_HOSTNAME_LENGTH) {
    return `${label}.${zoneName} is longer than ${MAX_HOSTNAME_LENGTH} characters.`;
  }
  return null;
}

export function hostnameProblem(fqdn: string): string | null {
  if (!fqdn) return 'Enter an address.';
  if (fqdn.length > MAX_HOSTNAME_LENGTH) {
    return `An address can be at most ${MAX_HOSTNAME_LENGTH} characters.`;
  }
  const labels = fqdn.split('.');
  if (labels.length < 2) return 'Use a full address, such as app.example.com.';
  for (const label of labels) {
    if (!label) return 'An address cannot contain empty parts.';
    const problem = labelProblem(label);
    if (problem) return problem;
  }
  return null;
}

/** The single label `fqdn` uses under `zoneName`, or null when it is not one. */
export function labelUnderZone(
  fqdn: string | null | undefined,
  zoneName: string,
): string | null {
  if (!fqdn?.endsWith(`.${zoneName}`)) return null;
  const label = fqdn.slice(0, fqdn.length - zoneName.length - 1);
  return label && !label.includes('.') ? label : null;
}
