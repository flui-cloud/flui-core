const LABEL: Record<string, string> = {
  hetzner: 'Hetzner',
  scaleway: 'Scaleway',
  ovh: 'OVHcloud',
};

const REFUSED =
  /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid (api )?(token|key|credential)|token you have provided is invalid/i;

/** What to do when a provider turned the stored key down, or nothing when it did not. */
export function refusedKeyHint(
  message: string,
  provider: string,
): string | undefined {
  if (!REFUSED.test(message)) return undefined;
  const label = LABEL[provider] ?? provider;
  return `${label} refused the stored key. Store a valid one with:  flui config set ${provider}`;
}

/** oclif's own exit, thrown by `this.exit()`: not an error to report. */
export function isOclifExit(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'oclif' in error &&
    typeof (error as { oclif?: { exit?: unknown } }).oclif?.exit === 'number'
  );
}
