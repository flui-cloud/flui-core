export interface ProviderConnection {
  pat: string;
  host: string;
}

/** Flui's own service account at the identity provider, and the Host it answers to. */
export function serviceConnection(
  env: NodeJS.ProcessEnv = process.env,
): ProviderConnection | null {
  const pat = (env.ZITADEL_SERVICE_ACCOUNT_PAT ?? '').trim();
  const issuer = (env.OIDC_ISSUER ?? env.ZITADEL_ISSUER ?? '').trim();
  if (!pat || !issuer) return null;
  return { pat, host: issuer.replace(/^https?:\/\//, '').replace(/\/$/, '') };
}
