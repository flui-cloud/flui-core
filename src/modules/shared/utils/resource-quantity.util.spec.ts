import {
  ResourceQuantityError,
  cpuMillicoresOf,
  limitBelowRequest,
  memoryMiOf,
  normalizeCpu,
  normalizeMemory,
  normalizeResourcePair,
} from './resource-quantity.util';

describe('resource quantities', () => {
  it('writes memory as a whole number of Mi, never a fraction of a byte', () => {
    expect(normalizeMemory('2.26Gi')).toBe('2315Mi');
    expect(normalizeMemory('2426656522240m')).toBe('2315Mi');
    expect(normalizeMemory('1.5Gi')).toBe('1536Mi');
    expect(normalizeMemory('2Gi')).toBe('2Gi');
    expect(normalizeMemory('2048Mi')).toBe('2Gi');
    expect(normalizeMemory('256Mi')).toBe('256Mi');
    expect(normalizeMemory('1G')).toBe('954Mi');
    expect(normalizeMemory('134217728')).toBe('128Mi');
  });

  it('writes cpu as whole millicores', () => {
    expect(normalizeCpu('0.5')).toBe('500m');
    expect(normalizeCpu('1.6')).toBe('1600m');
    expect(normalizeCpu('2')).toBe('2');
    expect(normalizeCpu('2000m')).toBe('2');
    expect(normalizeCpu('250m')).toBe('250m');
    expect(normalizeCpu('0.0005')).toBe('1m');
  });

  it('refuses what is not a quantity', () => {
    expect(() => memoryMiOf('lots')).toThrow(ResourceQuantityError);
    expect(() => memoryMiOf('0Mi')).toThrow(ResourceQuantityError);
    expect(() => cpuMillicoresOf('1 core')).toThrow(ResourceQuantityError);
    expect(() => cpuMillicoresOf('0')).toThrow(ResourceQuantityError);
  });

  it('normalises only the fields that were given', () => {
    expect(
      normalizeResourcePair({
        requests: { memory: '1.5Gi' },
        limits: { cpu: '1.25' },
      }),
    ).toEqual({
      requests: { memory: '1536Mi' },
      limits: { cpu: '1250m' },
    });
  });

  it('says when a limit sits below its request', () => {
    expect(
      limitBelowRequest({
        requests: { memory: '2Gi' },
        limits: { memory: '1536Mi' },
      }),
    ).toMatch(/memory limit \(1536Mi\) is below the memory request \(2Gi\)/);
    expect(
      limitBelowRequest({ requests: { cpu: '500m' }, limits: { cpu: '250m' } }),
    ).toMatch(/CPU limit/);
    expect(
      limitBelowRequest({
        requests: { cpu: '500m', memory: '1Gi' },
        limits: { cpu: '500m', memory: '1Gi' },
      }),
    ).toBeNull();
  });
});
