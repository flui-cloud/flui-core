import { ScalingGroupEntity } from '../entities/scaling-group.entity';

type GroupFields = Pick<
  ScalingGroupEntity,
  | 'name'
  | 'minNodes'
  | 'desiredNodes'
  | 'maxNodes'
  | 'regions'
  | 'shapes'
  | 'strategy'
  | 'settleSeconds'
  | 'hourlyBillingOnly'
  | 'maxMonthlyCost'
  | 'provision'
  | 'standingOrders'
  | 'requirement'
>;

export function snapshotOf(group: GroupFields): GroupFields {
  return structuredClone({
    name: group.name,
    minNodes: group.minNodes,
    desiredNodes: group.desiredNodes,
    maxNodes: group.maxNodes,
    regions: group.regions ?? [],
    shapes: group.shapes ?? [],
    strategy: group.strategy,
    settleSeconds: group.settleSeconds,
    hourlyBillingOnly: group.hourlyBillingOnly,
    maxMonthlyCost: group.maxMonthlyCost ?? null,
    provision: group.provision,
    standingOrders: group.standingOrders ?? [],
    requirement: group.requirement ?? null,
  });
}

/**
 * What changed in a group, one phrase per setting, in the words a person would
 * use to check a purchase against the rules it was bought under.
 */
export function groupChanges(
  before: GroupFields,
  after: GroupFields,
): string[] {
  const out: string[] = [];
  if (before.name !== after.name)
    out.push(`name ${before.name} → ${after.name}`);
  const bounds = (g: GroupFields) =>
    `${g.minNodes}/${g.desiredNodes}/${g.maxNodes}`;
  if (bounds(before) !== bounds(after)) {
    out.push(`nodes floor/target/ceiling ${bounds(before)} → ${bounds(after)}`);
  }
  if (!same(before.shapes, after.shapes)) {
    out.push(`machines ${list(before.shapes)} → ${list(after.shapes)}`);
  }
  if (!same(before.regions, after.regions)) {
    out.push(`regions ${list(before.regions)} → ${list(after.regions)}`);
  }
  if (before.maxMonthlyCost !== after.maxMonthlyCost) {
    out.push(
      `spend ceiling ${eur(before.maxMonthlyCost)} → ${eur(after.maxMonthlyCost)}`,
    );
  }
  if (before.provision !== after.provision) {
    out.push(`mode ${before.provision} → ${after.provision}`);
  }
  if (before.strategy !== after.strategy) {
    out.push(`strategy ${before.strategy} → ${after.strategy}`);
  }
  if (before.settleSeconds !== after.settleSeconds) {
    out.push(
      `wait before acting ${before.settleSeconds}s → ${after.settleSeconds}s`,
    );
  }
  if (before.hourlyBillingOnly !== after.hourlyBillingOnly) {
    out.push(
      after.hourlyBillingOnly
        ? 'hourly billing only: on'
        : 'hourly billing only: off',
    );
  }
  if (
    JSON.stringify(before.standingOrders) !==
    JSON.stringify(after.standingOrders)
  ) {
    out.push(
      `standing orders ${before.standingOrders.length} → ${after.standingOrders.length}`,
    );
  }
  if (
    JSON.stringify(before.requirement) !== JSON.stringify(after.requirement)
  ) {
    out.push('node requirement changed');
  }
  return out;
}

function same(a: string[], b: string[]): boolean {
  const byCodeUnit = (x: string, y: string) => (x < y ? -1 : Number(x > y));
  return (
    [...a].sort(byCodeUnit).join(',') === [...b].sort(byCodeUnit).join(',')
  );
}

function list(values: string[]): string {
  return values.length ? values.join(', ') : 'any';
}

function eur(value: number | null): string {
  return value === null ? 'none' : `€${value}`;
}
