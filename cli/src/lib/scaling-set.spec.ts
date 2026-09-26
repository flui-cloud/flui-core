import { changeOf } from './scaling-set';

const group = {
  bounds: { min: 1, desired: 1, max: 3 },
  limits: { hourlyBillingOnly: true, maxMonthlyCost: 30 },
} as never;

describe('flui scaling set', () => {
  it('keeps the ceiling when only the hourly rule changes, and restates the bounds whole', () => {
    expect(changeOf(group, { 'hourly-only': false, max: 4 })).toEqual({
      limits: { hourlyBillingOnly: false, maxMonthlyCost: 30 },
      bounds: { min: 1, desired: 1, max: 4 },
    });
  });

  it('removes the ceiling only when asked to', () => {
    expect(changeOf(group, { 'max-monthly': 'none' }).limits).toEqual({
      hourlyBillingOnly: true,
      maxMonthlyCost: null,
    });
  });

  it('sends only the blocks a flag touches', () => {
    expect(
      changeOf(group, { provision: 'manual', shapes: 'cx33, cx23' }),
    ).toEqual({
      provision: 'manual',
      shapes: ['cx33', 'cx23'],
    });
  });

  it('refuses a ceiling that is not an amount', () => {
    expect(() => changeOf(group, { 'max-monthly': 'lots' })).toThrow(
      '--max-monthly',
    );
  });
});
