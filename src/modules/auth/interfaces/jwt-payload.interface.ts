export interface JwtPayload {
  sub: string;
  email: string;
  iss: string;
  aud: string | string[];
  /**
   * The provider's project roles, as a *human* login carries them.
   *
   * Not the only shape they arrive in: a token obtained with the
   * `urn:zitadel:iam:org:projects:roles` scope — which is what a machine
   * identity has to ask for — carries them under
   * `urn:zitadel:iam:org:project:<projectId>:roles` instead, one claim per
   * project. `projectRolesOf` reads both; see the note there for why reading
   * only this one was a silent widening rather than a missing feature.
   */
  'urn:zitadel:iam:org:project:roles'?: Record<string, Record<string, string>>;
  /** Standard OAuth2 space-delimited scope claim, when granted on the token. */
  scope?: string;
  /** Issued-at, added automatically by jsonwebtoken on every decode. */
  iat?: number;
  /** Every other claim, including the project-scoped role claims above. */
  [claim: string]: unknown;
}
