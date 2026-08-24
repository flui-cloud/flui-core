/**
 * What a caller needs in order to talk to the bundled identity provider's admin
 * API: where it lives, and the credential to reach it with.
 *
 * Named as an interface with a token rather than taken as a concrete service so
 * that a consumer does not drag the whole bootstrap — and, through it, the
 * Kubernetes client — into its own module graph. `OidcBootstrapService` is the
 * only implementation and is bound to the token where it is provided.
 */
export interface ProviderAdminContext {
  pat: string;
  providerDomain: string;
  issuer: string;
  kubeconfig: string;
}

export interface ProviderAdminContextSource {
  /** `null` when there is no provider — an installation in `AUTH_MODE=local`. */
  resolveProviderContext(): Promise<ProviderAdminContext | null>;
  /** Brings the provider's project roles up to the vocabulary this build knows. */
  reconcileProjectRoles(): Promise<{ created: number } | null>;
}

export const PROVIDER_ADMIN_CONTEXT = Symbol('PROVIDER_ADMIN_CONTEXT');
