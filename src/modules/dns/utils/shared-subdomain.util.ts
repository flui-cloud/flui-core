import {
  FQDN_MAX,
  isValidLabel,
  normalizeName,
} from './tenancy-subdomain.util';

/**
 * The one subdomain every sandbox tenancy on an installation publishes under.
 *
 *     <slug>.<label>.<zone>          the application's name
 *     *.<label>.<zone>               the certificate, one for the installation
 *     *.<label>                      the DNS record, one for the installation
 *
 * `<label>` is a label inside the zone the instance already has — `demo` by
 * default, so `demo.flui.cloud` when the zone is `flui.cloud`. It is never a
 * delegated zone: nothing new has to be created at a registrar for this to
 * work.
 *
 * **Why one name for everybody and not one per tenancy.** A certificate per
 * tenancy makes the number of ACME orders a function of how many guests pass
 * through, and an ACME account has a weekly ceiling. Hundreds of guests would
 * spend it. Sharing one subdomain makes issuance a constant of the
 * installation instead — see `TenancySubdomainService` for the per-tenancy
 * shape that was measured and then excluded for exactly this reason.
 *
 * The applications sit **one label under** `<label>`, which is the same depth
 * they sit at today under `<cluster>`: `*.<label>` synthesises for all of them
 * and no intermediate node ever appears to stop it.
 */

/**
 * `<label>.<zone>` — the shared subdomain, and the scope of its wildcard
 * certificate. Null when either part is not a hostname, or when the result
 * leaves no room for a name underneath it: a certificate for a scope nothing
 * fits inside is an order spent on nothing.
 */
export function buildSharedSubdomain(input: {
  label: string;
  zoneName: string;
}): string | null {
  const label = normalizeName(input.label);
  if (!isValidLabel(label)) return null;

  const zone = normalizeName(input.zoneName);
  if (!zone?.split('.').every(isValidLabel)) return null;

  const subdomain = `${label}.${zone}`;
  return subdomain.length + 2 <= FQDN_MAX ? subdomain : null;
}

/**
 * `*.<label>` — the record name as a DNS provider wants it, relative to the
 * zone, matching how `clusterWildcardRecord` names `*.<cluster>`.
 */
export function sharedWildcardRecordName(label: string): string | null {
  const normalized = normalizeName(label);
  return isValidLabel(normalized) ? `*.${normalized}` : null;
}
