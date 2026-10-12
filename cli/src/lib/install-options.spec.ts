import { parseInstallOptions } from './install-options';

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
