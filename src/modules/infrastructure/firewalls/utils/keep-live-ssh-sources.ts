import { FirewallRuleDto } from '../../../providers/dto/firewall.dto';

const isSsh = (r: FirewallRuleDto): boolean =>
  r.direction === 'in' && r.protocol === 'tcp' && r.port === '22';

/**
 * The rules about to be applied, with every SSH source that is live on the
 * provider but missing from Flui's rules put back into the operator's SSH
 * rule. Such a source was added by hand — often the address someone is
 * working from — and dropping it silently is how an operator gets locked out.
 * Rules Flui owns (`flui:`) are never widened, and when Flui's rules have no
 * public SSH rule of the operator's the port stays as Flui decided.
 */
export function keepLiveSshSources(
  desired: FirewallRuleDto[],
  live: FirewallRuleDto[] | undefined,
): { rules: FirewallRuleDto[]; kept: string[] } {
  const operatorSsh = desired.findIndex(
    (r) => isSsh(r) && !r.description?.startsWith('flui:'),
  );
  if (operatorSsh === -1) return { rules: desired, kept: [] };

  const known = new Set(
    desired.filter(isSsh).flatMap((r) => r.sourceIps ?? []),
  );
  const kept = [
    ...new Set(
      (live ?? [])
        .filter(isSsh)
        .flatMap((r) => r.sourceIps ?? [])
        .filter((ip) => !known.has(ip)),
    ),
  ];
  if (kept.length === 0) return { rules: desired, kept };

  const rules = desired.map((r, i) =>
    i === operatorSsh
      ? { ...r, sourceIps: [...(r.sourceIps ?? []), ...kept] }
      : r,
  );
  return { rules, kept };
}
