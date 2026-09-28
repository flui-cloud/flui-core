import { MigrationInterface } from 'typeorm';
import { migrations } from './index';
import {
  OperationStep,
  OperationType,
} from '../modules/infrastructure/servers/entities/infrastructure-operations.entity';

/**
 * Production builds its schema from these migrations only, so an operation
 * type or step the code writes and no migration adds is an insert Postgres
 * refuses — and it surfaces the first time somebody runs the feature. Every
 * migration is run against a recorder and the enum values it would create are
 * compared with the entity's.
 */
async function operationEnumValues(
  list: Array<new () => MigrationInterface>,
): Promise<{ type: Set<string>; step: Set<string> }> {
  const out = { type: new Set<string>(), step: new Set<string>() };
  const collect = (sql: string) => {
    for (const [key, name] of [
      ['type', 'operationtype'],
      ['step', 'currentstep'],
    ] as const) {
      const enumName = `infrastructure_operations_${name}_enum`;
      if (!sql.includes(enumName)) continue;
      const created = new RegExp(`${enumName}" AS ENUM\\(([^)]*)\\)`).exec(sql);
      for (const m of (created?.[1] ?? '').matchAll(/'([^']+)'/g)) {
        out[key].add(m[1]);
      }
      for (const m of sql.matchAll(/ADD VALUE(?: IF NOT EXISTS)? '([^']+)'/g)) {
        out[key].add(m[1]);
      }
    }
  };
  const runner = {
    query: async (sql: string) => {
      collect(sql);
      return [];
    },
  };
  for (const Migration of list) {
    await new Migration().up(runner as never).catch(() => undefined);
  }
  return out;
}

describe('operation enums in the migrations', () => {
  let values: { type: Set<string>; step: Set<string> };

  beforeAll(async () => {
    values = await operationEnumValues(migrations as never);
  });

  it('creates every operation type the entity declares', () => {
    const missing = Object.values(OperationType).filter(
      (v) => !values.type.has(v),
    );
    expect(missing).toEqual([]);
  });

  it('creates every operation step the entity declares', () => {
    const missing = Object.values(OperationStep).filter(
      (v) => !values.step.has(v),
    );
    expect(missing).toEqual([]);
  });

  it('adds the K3s upgrade type and the platform update steps', () => {
    expect(values.type.has('upgrade_k3s')).toBe(true);
    for (const step of [
      'platform_update_backup',
      'platform_update_manifests',
      'platform_update_k3s',
      'platform_update_control_plane',
    ]) {
      expect(values.step.has(step)).toBe(true);
    }
  });
});
