import { parseSlot, windowOf } from './maintenance-slot';

describe('parseSlot', () => {
  it('reads days, start and length', () => {
    expect(parseSlot('tue,thu 02:00 2h')).toEqual({
      days: ['tue', 'thu'],
      start: '02:00',
      durationMinutes: 120,
    });
    expect(parseSlot('SUN 23:30 1h30m').durationMinutes).toBe(90);
    expect(parseSlot('sat 04:00 45').durationMinutes).toBe(45);
  });

  it('says what is wrong in a way a person can fix', () => {
    expect(() => parseSlot('tue 02:00')).toThrow(/e.g. "tue,thu 02:00 2h"/);
    expect(() => parseSlot('tuesday 02:00 2h')).toThrow(/days are mon/);
    expect(() => parseSlot('tue 2am 2h')).toThrow(/HH:MM/);
    expect(() => parseSlot('tue 02:00 soon')).toThrow(/90m, 2h/);
  });

  it('builds a window from several slots', () => {
    expect(
      windowOf(['tue 02:00 2h', 'sat 03:00 1h'], 'Europe/Rome').slots,
    ).toHaveLength(2);
  });
});
