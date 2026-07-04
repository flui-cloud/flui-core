/**
 * Zone-relative record name for a FQDN: `@` for the apex, otherwise the FQDN
 * with the trailing `.zoneName` stripped. Shared by the write path and the
 * reconciliation loop so both agree on record identity (a disagreement would
 * make the cron thrash create/delete).
 */
export function resolveRecordName(fqdn: string, zoneName: string): string {
  if (fqdn === zoneName) {
    return '@';
  }
  if (fqdn.endsWith(`.${zoneName}`)) {
    return fqdn.slice(0, fqdn.length - zoneName.length - 1);
  }
  return fqdn;
}
