export interface StatusAlertItem {
  id: string;
  name: string;
  path: string;
}

const NAMED = 3;

/** The policies whose cluster is gone, each named so a person can find it. */
export function orphanPoliciesAlert(
  policies: Array<{ id: string; name: string }>,
): {
  severity: 'warning';
  code: 'ORPHAN_POLICIES';
  message: string;
  ctaLabel: string;
  ctaPath: string;
  items: StatusAlertItem[];
} | null {
  const n = policies.length;
  if (n === 0) return null;
  const names = policies.slice(0, NAMED).map((p) => p.name);
  const rest = n - names.length;
  const named =
    rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ');
  const one = n === 1;
  return {
    severity: 'warning',
    code: 'ORPHAN_POLICIES',
    message: one
      ? `Backup policy ${named} points at a cluster that no longer exists. It protects nothing; its backups stay restorable.`
      : `${n} backup policies point at a cluster that no longer exists: ${named}. They protect nothing; their backups stay restorable.`,
    ctaLabel: one ? 'Open policy' : 'Open policies',
    ctaPath: one
      ? `/management/backup/policies/${policies[0].id}`
      : '/management/backup/policies',
    items: policies.map((p) => ({
      id: p.id,
      name: p.name,
      path: `/management/backup/policies/${p.id}`,
    })),
  };
}
