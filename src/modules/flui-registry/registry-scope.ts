/**
 * The registry token grant: what a credential asked for, narrowed to the one
 * repository it belongs to. Never more than requested, never another name —
 * a scope naming any other repository is dropped, not refused, as the token
 * specification allows, and the registry then refuses the operation itself.
 */
export type RegistryAction = 'pull' | 'push';

export interface RegistryAccess {
  type: 'repository';
  name: string;
  actions: RegistryAction[];
}

const ACTIONS: readonly RegistryAction[] = ['pull', 'push'];

export function parseRegistryScopes(
  raw: string | string[] | undefined,
): Array<{ type: string; name: string; actions: string[] }> {
  const values = (Array.isArray(raw) ? raw : [raw ?? ''])
    .flatMap((value) => value.split(' '))
    .filter(Boolean);
  return values.flatMap((scope) => {
    const first = scope.indexOf(':');
    const last = scope.lastIndexOf(':');
    if (first < 0 || last === first) return [];
    return [
      {
        type: scope.slice(0, first),
        name: scope.slice(first + 1, last),
        actions: scope
          .slice(last + 1)
          .split(',')
          .filter(Boolean),
      },
    ];
  });
}

export function grantRegistryAccess(
  requested: Array<{ type: string; name: string; actions: string[] }>,
  allowed: { name: string; actions: readonly RegistryAction[] },
): RegistryAccess[] {
  const granted = new Set<RegistryAction>();
  for (const scope of requested) {
    if (scope.type !== 'repository' || scope.name !== allowed.name) continue;
    for (const action of scope.actions) {
      const known = ACTIONS.find((a) => a === action);
      if (known && allowed.actions.includes(known)) granted.add(known);
    }
  }
  if (granted.size === 0) return [];
  return [
    {
      type: 'repository',
      name: allowed.name,
      actions: ACTIONS.filter((a) => granted.has(a)),
    },
  ];
}
