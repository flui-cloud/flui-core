import { QueryRunner } from 'typeorm';
import { RegistryStorage1790000000025 } from './1790000000025-RegistryStorage';
import { migrations } from './index';

describe('RegistryStorage1790000000025', () => {
  it('allows one active bucket at a time', async () => {
    const statements: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [];
      }),
    } as unknown as QueryRunner;
    await new RegistryStorage1790000000025().up(runner);
    expect(statements.join('\n')).toContain(
      'ON "registry_storage" ("active") WHERE "active"',
    );
  });

  it('is registered after the registry tables', () => {
    const at = migrations.indexOf(RegistryStorage1790000000025);
    expect(migrations[at - 1].name).toBe('FluiRegistry1790000000024');
  });
});
