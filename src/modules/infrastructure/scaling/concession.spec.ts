import { readConcession } from './concession';

describe('the spending grant', () => {
  it('grants nothing when nobody granted anything', () => {
    expect(readConcession(undefined).granted).toBe(false);
    expect(readConcession('').granted).toBe(false);
    expect(readConcession('   ').granted).toBe(false);
  });

  it('names the variable, because a reader who never set it has no other way to know', () => {
    expect(readConcession(undefined).says).toContain(
      'SCALING_CONCESSION_MONTHLY_EUR',
    );
  });

  it('refuses a typo rather than reading one as permission', () => {
    for (const bad of ['forty', '40eur', 'true', '-5', 'NaN']) {
      const read = readConcession(bad);
      expect(read.granted).toBe(false);
      expect(read.monthlyEur).toBeNull();
    }
  });

  it('says so when the value is unreadable, instead of behaving as if it were absent', () => {
    expect(readConcession('forty').says).toContain('"forty"');
  });

  it('takes zero as a grant of nothing, which is not the same as no grant', () => {
    const read = readConcession('0');
    expect(read.granted).toBe(true);
    expect(read.monthlyEur).toBe(0);
    expect(read.says).toContain('still decide');
  });

  it('grants an amount, and states it in the sentence somebody has to agree to', () => {
    const read = readConcession('40');
    expect(read).toMatchObject({ granted: true, monthlyEur: 40 });
    expect(read.says).toContain('€40 a month');
  });
});
