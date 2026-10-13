const GITHUB_LOGIN_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function organizationError(organization?: string): string | null {
  if (organization === undefined) return null;
  if (GITHUB_LOGIN_PATTERN.test(organization.trim())) return null;
  return `"${organization}" is not a GitHub organisation name: use its login as it appears in github.com/<organisation>.`;
}

export interface ManifestStartInput {
  name: string;
  webhooksEnabled: boolean;
  publicApp: boolean;
  publicApiUrl: string;
  organization?: string;
}

export function manifestStartBody(
  input: ManifestStartInput,
): ManifestStartInput {
  const body: ManifestStartInput = {
    name: input.name,
    webhooksEnabled: input.webhooksEnabled,
    publicApp: input.publicApp,
    publicApiUrl: input.publicApiUrl,
  };
  const organization = input.organization?.trim();
  if (organization) body.organization = organization;
  return body;
}
