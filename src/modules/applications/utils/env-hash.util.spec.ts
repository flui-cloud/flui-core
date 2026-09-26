import { envChanges, envHashOf } from './env-hash.util';

const v = (name: string, value: string, secret = false) =>
  ({ name, value, secret }) as never;

describe('env hash and changes', () => {
  it('does not depend on the order variables are stored in', () => {
    expect(envHashOf([v('A', '1'), v('B', '2')])).toBe(
      envHashOf([v('B', '2'), v('A', '1')]),
    );
  });

  it('changes when a value changes, and ignores a variable still awaiting its value', () => {
    expect(envHashOf([v('A', '1')])).not.toBe(envHashOf([v('A', '2')]));
    expect(envHashOf([v('A', '1')])).toBe(
      envHashOf([
        v('A', '1'),
        { name: 'W', value: '', pending: true } as never,
      ]),
    );
  });

  it('names what changed and never says a value', () => {
    expect(
      envChanges(
        [v('A', '1'), v('GONE', 'x')],
        [v('A', '2', true), v('NEW', 's3cr3t', true)],
      ),
    ).toEqual(['A changed', 'GONE removed', 'NEW added']);
  });
});
