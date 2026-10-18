import { FIT, fitsFlui } from './server-type-fit';

const type = (over: Partial<Parameters<typeof fitsFlui>[0]> = {}) => ({
  cores: 2,
  memory: 8,
  architecture: 'x86' as const,
  bareMetal: false,
  supportsHourlyBilling: true,
  ...over,
});

describe('a server type Flui can start on', () => {
  it('takes a small x86 cloud server billed by the hour', () => {
    expect(fitsFlui(type(), 43)).toBe(true);
  });

  it.each([
    ['arm', type({ architecture: 'arm' })],
    ['bare metal', type({ bareMetal: true })],
    ['monthly only', type({ supportsHourlyBilling: false })],
    ['too small', type({ memory: 2 })],
    ['one core', type({ cores: 1 })],
    ['oversized', type({ cores: 32, memory: 128 })],
  ])('leaves out %s', (_why, candidate) => {
    expect(fitsFlui(candidate, 20)).toBe(false);
  });

  it('keeps to the price cap, and leaves out a type with no price', () => {
    expect(fitsFlui(type(), FIT.maxMonthlyPrice)).toBe(true);
    expect(fitsFlui(type(), FIT.maxMonthlyPrice + 1)).toBe(false);
    expect(fitsFlui(type(), Number.POSITIVE_INFINITY)).toBe(false);
    expect(fitsFlui(type(), 150, 200)).toBe(true);
  });
});
