import { boolOr, migrationsWanted } from './migrations-once';

describe('when the API applies migrations before it starts', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('applies them in production unless told not to', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DB_MIGRATIONS_RUN;
    expect(migrationsWanted()).toBe(true);
    process.env.DB_MIGRATIONS_RUN = 'false';
    expect(migrationsWanted()).toBe(false);
  });

  it('leaves a developer API alone unless asked', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DB_MIGRATIONS_RUN;
    expect(migrationsWanted()).toBe(false);
    process.env.DB_MIGRATIONS_RUN = 'true';
    expect(migrationsWanted()).toBe(true);
  });

  it('reads an empty setting as unset', () => {
    expect(boolOr('', true)).toBe(true);
    expect(boolOr('TRUE', false)).toBe(true);
  });
});
