import { quoteTxtValue } from './hetzner-dns.service';

describe('quoteTxtValue', () => {
  it('quotes a bare value, because Hetzner rejects one that is not', () => {
    // Verbatim from the API: "TXT records must be fully escaped with double quotes".
    expect(quoteTxtValue('v=spf1 include:_spf.tem.scaleway.com -all')).toBe(
      '"v=spf1 include:_spf.tem.scaleway.com -all"',
    );
  });

  it('leaves an already-quoted value alone rather than nesting the quotes', () => {
    // Re-quoting would publish a value whose first character is a quote mark —
    // a record that looks right in the zone file and never matches.
    expect(quoteTxtValue('"v=DMARC1; p=none"')).toBe('"v=DMARC1; p=none"');
  });

  it('leaves an already-chunked value alone', () => {
    expect(quoteTxtValue('"part-one" "part-two"')).toBe(
      '"part-one" "part-two"',
    );
  });

  it('splits past 255 characters, which is where DKIM keys live', () => {
    // A TXT record is a sequence of strings of at most 255 bytes each; a single
    // longer string is not representable, and DKIM keys are routinely ~400.
    const key = `v=DKIM1; k=rsa; p=${'A'.repeat(400)}`;
    const quoted = quoteTxtValue(key);

    const chunks = quoted.match(/"([^"]*)"/g)!;
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length - 2).toBeLessThanOrEqual(255);
    }
    // Receivers join the chunks with nothing — so the value must survive intact.
    expect(chunks.map((c) => c.slice(1, -1)).join('')).toBe(key);
  });

  it('escapes an embedded quote instead of ending the string early', () => {
    expect(quoteTxtValue('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('trims, so a stray newline does not become part of the record', () => {
    expect(quoteTxtValue('  v=DMARC1; p=none\n')).toBe('"v=DMARC1; p=none"');
  });
});
