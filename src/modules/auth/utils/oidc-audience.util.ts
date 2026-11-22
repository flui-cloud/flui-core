/**
 * The audience a Flui token must carry: the dashboard's client, which the
 * identity provider adds to the audience of every app in the Flui project.
 * Read on every request, not once at boot: a fresh installation learns it
 * from the OIDC bootstrap while already serving, without a restart.
 */
export function currentOidcAudience(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = (env.OIDC_AUDIENCE || env.ZITADEL_AUDIENCE || '').trim();
  return value || undefined;
}

/** False while no audience is known: until then no token can be told apart from another app's. */
export function carriesFluiAudience(
  aud: string | string[] | undefined,
  expected: string | undefined = currentOidcAudience(),
): boolean {
  if (!expected) return false;
  if (Array.isArray(aud)) return aud.includes(expected);
  return aud === expected;
}
