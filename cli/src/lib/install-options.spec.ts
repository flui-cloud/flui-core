import { parseDependencyChoices, parseInstallOptions } from './install-options';

describe('parseInstallOptions', () => {
  it('reads repeated key=true|false pairs', () => {
    expect(
      parseInstallOptions(['pooler=false', 'poolerSessionMode=TRUE']),
    ).toEqual({ pooler: false, poolerSessionMode: true });
  });

  it('sends nothing when no option was given, so the declared defaults apply', () => {
    expect(parseInstallOptions(undefined)).toBeUndefined();
    expect(parseInstallOptions([])).toBeUndefined();
  });

  it('refuses anything that is not a boolean', () => {
    expect(() => parseInstallOptions(['pooler=yes'])).toThrow(
      /key=true\|false/,
    );
    expect(() => parseInstallOptions(['=true'])).toThrow();
    expect(() => parseInstallOptions(['pooler'])).toThrow();
  });
});

describe('parseDependencyChoices', () => {
  const ID = '0b6f2a5e-8d1c-4c1e-9f3a-2d4b6c8e0a12';

  it('reads "new" as a dedicated block and an application id as reuse', () => {
    expect(parseDependencyChoices(['kafka=new', `db=${ID}`])).toEqual([
      { alias: 'kafka', mode: 'DEDICATED' },
      { alias: 'db', mode: 'REUSE_EXISTING', existingApplicationId: ID },
    ]);
  });

  it('sends nothing when no dependency was named', () => {
    expect(parseDependencyChoices(undefined)).toBeUndefined();
  });

  it('refuses a target that is neither "new" nor an id', () => {
    expect(() => parseDependencyChoices(['kafka=my-kafka'])).toThrow(
      /neither "new" nor an application id/,
    );
    expect(() => parseDependencyChoices(['kafka'])).toThrow();
  });
});
