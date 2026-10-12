import { MASKED_QUERY_MAX, maskSqlLiterals } from './mask-sql-literals';

describe('maskSqlLiterals', () => {
  it('never shows a password set on a role', () => {
    const out = maskSqlLiterals("ALTER ROLE app PASSWORD 's3cr3t'");
    expect(out).toBe('ALTER ROLE app PASSWORD ?');
    expect(out).not.toContain('s3cr3t');
  });

  it('keeps the shape of a statement and drops its values', () => {
    expect(
      maskSqlLiterals(
        "UPDATE accounts SET balance = 10.5 WHERE id = 42 AND name = 'bob'",
      ),
    ).toBe('UPDATE accounts SET balance = ? WHERE id = ? AND name = ?');
  });

  it('masks doubled quotes and escape strings whole', () => {
    expect(maskSqlLiterals("SELECT 'it''s', E'a\\'b', e'x'")).toBe(
      'SELECT ?, ?, ?',
    );
  });

  it('reads a backslash before a quote as an escape only in an E string', () => {
    const escaped = maskSqlLiterals("SELECT E'ab\\'cd' AS v");
    expect(escaped).toBe('SELECT ? AS v');
    expect(escaped).not.toContain('cd');
    expect(maskSqlLiterals("SELECT E'a\\\\', 'x'")).toBe('SELECT ?, ?');
    expect(maskSqlLiterals("SELECT 'ab\\', 'cd'")).toBe('SELECT ?, ?');
  });

  it('masks unicode, bit and hex strings', () => {
    expect(maskSqlLiterals("SELECT U&'d\\0061t', B'1010', X'1F', N'nat'")).toBe(
      'SELECT ?, ?, ?, ?',
    );
  });

  it('masks dollar-quoted bodies, tagged or not', () => {
    expect(
      maskSqlLiterals(
        "DO $fn$ BEGIN PERFORM set_config('k', 'secret', false); END $fn$; SELECT $$x$$",
      ),
    ).toBe('DO ?; SELECT ?');
  });

  it('keeps positional parameters and identifiers with digits', () => {
    expect(
      maskSqlLiterals('SELECT t1.col_2 FROM t1 WHERE a = $1 AND b = $12'),
    ).toBe('SELECT t1.col_2 FROM t1 WHERE a = $1 AND b = $12');
  });

  it('masks every kind of number', () => {
    expect(maskSqlLiterals('SELECT 1, .5, 2.5e-3, 0x1F, 1_000 LIMIT 10')).toBe(
      'SELECT ?, ?, ?, ?, ? LIMIT ?',
    );
  });

  it('removes comments, nested ones included', () => {
    expect(
      maskSqlLiterals(
        "SELECT 1 -- token 'abc'\nFROM t /* outer /* inner 'x' */ still */ WHERE true",
      ),
    ).toBe('SELECT ? FROM t WHERE true');
  });

  it('keeps quoted identifiers as written', () => {
    expect(
      maskSqlLiterals('SELECT "Weird ""Name""" FROM "T 1" WHERE x = 3'),
    ).toBe('SELECT "Weird ""Name""" FROM "T 1" WHERE x = ?');
  });

  describe('a statement the server cut short', () => {
    it('masks an open string to the end', () => {
      const out = maskSqlLiterals("ALTER ROLE app PASSWORD 'abcdefghij");
      expect(out).toBe('ALTER ROLE app PASSWORD ?');
      expect(out).not.toContain('abc');
    });

    it('masks an open escape string ending on a backslash', () => {
      expect(maskSqlLiterals("SELECT E'top\\'secret\\")).toBe('SELECT ?');
    });

    it('masks an open dollar-quoted body to the end', () => {
      const out = maskSqlLiterals(
        "CREATE FUNCTION f() AS $body$ SELECT 'pw123'",
      );
      expect(out).toBe('CREATE FUNCTION f() AS ?');
      expect(out).not.toContain('pw123');
    });

    it('drops an open block comment', () => {
      expect(maskSqlLiterals("SELECT 1 /* key 'x'")).toBe('SELECT ?');
    });
  });

  it('collapses whitespace and caps the length', () => {
    expect(maskSqlLiterals('SELECT   a,\n\t b  FROM  t')).toBe(
      'SELECT a, b FROM t',
    );
    const long = `SELECT ${'col, '.repeat(600)}x FROM t`;
    expect(maskSqlLiterals(long)).toHaveLength(MASKED_QUERY_MAX);
  });

  it('reads nothing into an empty statement', () => {
    expect(maskSqlLiterals(null)).toBe('');
    expect(maskSqlLiterals('')).toBe('');
  });
});
