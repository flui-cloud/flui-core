import {
  RegisterErrorRow,
  discloseRegisterError,
  readsErrorsVerbatim,
  registerErrorKind,
} from './register-error-disclosure';
import { MCP_SCOPE } from '../constants/mcp-scopes';

const row = (over: Partial<RegisterErrorRow> = {}): RegisterErrorRow => ({
  error: 'SSH exec failed (code 1): Warning: Permanently added ... hunter2',
  allowed: true,
  outcome: null,
  ...over,
});

describe('who reads a failure as it was written', () => {
  it('gives it to whoever administers access, from a session', () => {
    expect(readsErrorsVerbatim('instance', { scopes: undefined })).toBe(true);
    expect(readsErrorsVerbatim('instance', undefined)).toBe(true);
  });

  it('withholds it from a caller who reads only their own rows', () => {
    expect(readsErrorsVerbatim('own', undefined)).toBe(false);
  });

  /**
   * The one that is easy to get wrong. `mcp:iam:read` carries `iam:read-access`
   * by design, so an agent credential minted for it reaches instance scope and
   * would otherwise page every failure text in the product into a model's
   * context. A ceiling means the credential is not the whole person.
   */
  it('withholds it from an agent credential that reaches the whole instance', () => {
    expect(
      readsErrorsVerbatim('instance', { scopes: [MCP_SCOPE.IAM_READ] }),
    ).toBe(false);
  });
});

describe('the error column, disclosed', () => {
  it('is silent when the call did not fail', () => {
    expect(discloseRegisterError(row({ error: null }), false)).toEqual({
      text: null,
      withheld: false,
    });
  });

  it('hands the stored text to a reader entitled to it', () => {
    const disclosed = discloseRegisterError(row(), true);
    expect(disclosed.withheld).toBe(false);
    expect(disclosed.text).toContain('hunter2');
  });

  /**
   * The leak, in the shape it actually arrives in: a message built downstream
   * by concatenating command output. `describeError` returns `error.message`
   * untouched, so whatever the failing component put there reached every reader
   * of the panel — a sandbox guest included.
   */
  it('never lets a downstream message past a reader below the boundary', () => {
    const disclosed = discloseRegisterError(row(), false);
    expect(disclosed.withheld).toBe(true);
    expect(disclosed.text).not.toContain('hunter2');
    expect(disclosed.text).not.toContain('SSH');
  });

  it('says which kind of thing it is withholding, off the columns', () => {
    expect(discloseRegisterError(row({ allowed: false }), false).text).toMatch(
      /^Refused\./,
    );
    expect(
      discloseRegisterError(row({ outcome: 'input_required' }), false).text,
    ).toMatch(/^Waiting on a person\./);
    expect(discloseRegisterError(row(), false).text).toMatch(/^Failed\./);
  });

  /**
   * The classification cannot be steered by the thing being classified: a
   * message that says "Waiting on a person" is still a failure if the columns
   * say the call failed.
   */
  it('classifies on the columns, never on the text', () => {
    expect(
      registerErrorKind({
        error: 'Waiting on a person (HTTP 403): add nodes',
        allowed: false,
        outcome: null,
      }),
    ).toBe('refused');
  });

  /**
   * The same invariant `redactToolArgs` holds for the column beside this one:
   * what comes out verbatim is a member of a set written in Flui's own source.
   * These two are the whole stored value, with nothing interpolated.
   */
  it("lets through the refusals that are entirely Flui's own words", () => {
    for (const own of ['missing scope', 'destructive disabled']) {
      expect(discloseRegisterError(row({ error: own }), false)).toEqual({
        text: own,
        withheld: false,
      });
    }
  });

  it('withholds anything merely beginning with those words', () => {
    const disclosed = discloseRegisterError(
      row({ error: 'missing scope: mcp:app:write on app hunter2' }),
      false,
    );
    expect(disclosed.withheld).toBe(true);
    expect(disclosed.text).not.toContain('hunter2');
  });

  /**
   * A withheld error is not an absent one. `null` already means "nothing went
   * wrong", and a screen that showed a blank here would report a failed call as
   * a clean one.
   */
  it('never withholds by returning null', () => {
    expect(
      discloseRegisterError(row({ allowed: false }), false).text,
    ).not.toBeNull();
  });
});
