/**
 * The closed taxonomy a response field is classified under. `PUBLIC` is the
 * explicit "declared safe" state — without it, "untagged" and "safe" collapse
 * back into the same thing, which is the deny-list failure mask mode exists to
 * reject.
 */
export enum Sensitivity {
  PUBLIC = 'public',
  CREDENTIAL = 'credential',
  NETWORK_IDENTIFIER = 'network-identifier',
  TENANT_IDENTITY = 'tenant-identity',
  ARBITRARY_TEXT = 'arbitrary-text',
}
