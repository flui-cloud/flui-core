import { boundsAtFloor, buysOnItsOwn } from './scaling.core';

describe('the bounds once the floor moves', () => {
  it('moves the target with the floor', () => {
    expect(boundsAtFloor({ min: 1, desired: 1, max: 3 }, 2)).toEqual({
      min: 2,
      desired: 2,
      max: 3,
    });
    expect(boundsAtFloor({ min: 2, desired: 2, max: 3 }, 1)).toEqual({
      min: 1,
      desired: 1,
      max: 3,
    });
  });

  it('brings a target above the floor down to it', () => {
    expect(boundsAtFloor({ min: 1, desired: 3, max: 5 }, 2)).toEqual({
      min: 2,
      desired: 2,
      max: 5,
    });
  });

  it('never leaves the ceiling below the floor', () => {
    expect(boundsAtFloor({ min: 1, desired: 1, max: 1 }, 2)).toEqual({
      min: 2,
      desired: 2,
      max: 2,
    });
  });
});

describe('whether a group buys on its own', () => {
  it('needs automatic and a ceiling above zero', () => {
    expect(buysOnItsOwn({ provision: 'automatic', maxMonthlyCost: 30 })).toBe(
      true,
    );
    expect(buysOnItsOwn({ provision: 'automatic', maxMonthlyCost: null })).toBe(
      false,
    );
    expect(buysOnItsOwn({ provision: 'automatic', maxMonthlyCost: 0 })).toBe(
      false,
    );
    expect(buysOnItsOwn({ provision: 'manual', maxMonthlyCost: 30 })).toBe(
      false,
    );
  });
});
